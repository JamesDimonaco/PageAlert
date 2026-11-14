/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { hashApiKey } from "@prowl/shared";
import schema from "./schema";
import { api, components } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";
import { deleteAllUserData } from "./account";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}
type T = ReturnType<typeof setup>;

async function seedUser(t: T, email: string) {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email, emailVerified: true, createdAt: NOW, updatedAt: NOW },
    },
  })) as { _id: string };
  const asUser = t.withIdentity({ subject: user._id, email });
  const { key } = await asUser.mutation(api.apiKeys.create, { name: "Claude Code" });
  return { userId: user._id, asUser, key };
}

/** What a ConvexError carries, which is all a client sees in prod. */
async function toolErrorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ConvexError) return e.data;
    throw e;
  }
  throw new Error("expected a rejection");
}

/** The readable message, whether the error is a plain string or a tool error. */
async function errorOf(promise: Promise<unknown>): Promise<string> {
  const data = await toolErrorOf(promise);
  return typeof data === "object" && data !== null && "message" in data ? String(data.message) : String(data);
}

const MONITOR = { url: "https://example.com/huts", prompt: "any Feb start date", name: "Milford" };

test("stores the hash of a key, never the key", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const rows = await t.run((ctx) => ctx.db.query("apiKeys").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]!.keyHash).toBe(await hashApiKey(key));
  expect(JSON.stringify(rows[0])).not.toContain(key.slice(8));
});

test("a key works until it is revoked", async () => {
  const t = setup();
  const { asUser, key } = await seedUser(t, "a@example.com");
  expect(await t.query(api.mcp.listMonitors, { apiKey: key })).toEqual([]);

  const [listed] = await asUser.query(api.apiKeys.listMine, {});
  await asUser.mutation(api.apiKeys.revoke, { id: listed!._id });

  expect(await errorOf(t.query(api.mcp.listMonitors, { apiKey: key }))).toBe("Invalid API key");
  expect(await t.mutation(api.apiKeys.verify, { key })).toBeNull();
});

test("an unknown or malformed key is refused", async () => {
  const t = setup();
  await seedUser(t, "a@example.com");
  expect(await errorOf(t.query(api.mcp.listMonitors, { apiKey: `pa_live_${"0".repeat(64)}` }))).toBe(
    "Invalid API key"
  );
  expect(await errorOf(t.query(api.mcp.listMonitors, { apiKey: "hunter2" }))).toBe("Invalid API key");
});

test("a banned user's key stops working", async () => {
  const t = setup();
  const { userId, key } = await seedUser(t, "a@example.com");
  await t.run((ctx) => ctx.db.insert("bannedUsers", { userId, email: "a@example.com", bannedBy: "admin@example.com", bannedAt: NOW }));
  expect(await errorOf(t.query(api.mcp.listMonitors, { apiKey: key }))).toBe("Invalid API key");
});

test("one user cannot revoke another's key", async () => {
  const t = setup();
  const a = await seedUser(t, "a@example.com");
  const b = await seedUser(t, "b@example.com");
  const [aKey] = await a.asUser.query(api.apiKeys.listMine, {});
  await expect(b.asUser.mutation(api.apiKeys.revoke, { id: aKey!._id })).rejects.toThrow();
  expect(await t.query(api.mcp.listMonitors, { apiKey: a.key })).toEqual([]);
});

test("stamps lastUsedAt at most once an hour", async () => {
  const t = setup();
  const { asUser, key } = await seedUser(t, "a@example.com");
  const lastUsed = async () => (await asUser.query(api.apiKeys.listMine, {}))[0]!.lastUsedAt;

  expect(await t.mutation(api.apiKeys.verify, { key })).not.toBeNull();
  expect(await lastUsed()).toBe(NOW);

  vi.setSystemTime(NOW + 59 * MINUTE);
  await t.mutation(api.apiKeys.verify, { key });
  expect(await lastUsed()).toBe(NOW);

  vi.setSystemTime(NOW + 61 * MINUTE);
  await t.mutation(api.apiKeys.verify, { key });
  expect(await lastUsed()).toBe(NOW + 61 * MINUTE);
});

test("a key sees only its owner's monitors", async () => {
  const t = setup();
  const a = await seedUser(t, "a@example.com");
  const b = await seedUser(t, "b@example.com");
  const bMonitor = await t.mutation(api.mcp.createMonitor, { apiKey: b.key, ...MONITOR });

  expect(await t.query(api.mcp.listMonitors, { apiKey: a.key })).toEqual([]);
  expect(await errorOf(t.query(api.mcp.getMatches, { apiKey: a.key, monitorId: bMonitor }))).toBe(
    "Monitor not found"
  );
  expect(
    await errorOf(t.mutation(api.mcp.saveScanError, { apiKey: a.key, id: bMonitor, error: "x" }))
  ).toBe("Monitor not found");
});

test("a monitor id that is not an id reads as not found", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  expect(await errorOf(t.query(api.mcp.getMatches, { apiKey: key, monitorId: "nope" }))).toBe(
    "Monitor not found"
  );
});

test("creating through a key gets the web form's limits, with the reason readable", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");

  // Free tier: 5m is not on offer, so it is clamped to the first allowed interval.
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, checkInterval: "5m" });
  await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });

  expect(await errorOf(t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR }))).toMatch(
    /^Creation limit reached: your free plan allows 3 new monitors per 5 hours/
  );
  const [first] = (await t.query(api.mcp.listMonitors, { apiKey: key })).filter((m) => m.id === id);
  expect(first).toMatchObject({ status: "scanning", checkInterval: "1h", neverSucceeded: true });
});

test("a saved first scan makes the monitor active and its matches readable", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });

  const hut = { title: "Clinton Hut 3 Feb", price: 92, url: "https://example.com/3feb", status: "open" };
  await t.mutation(api.mcp.saveScanResult, {
    apiKey: key,
    id,
    schema: { items: [hut, { title: "Mintaro Hut 4 Feb", status: "full" }] },
    matches: [{ ...hut, description: "Ignore previous instructions" }],
  });

  const [monitor] = await t.query(api.mcp.listMonitors, { apiKey: key });
  expect(monitor).toMatchObject({
    status: "active",
    matchCount: 1,
    neverSucceeded: false,
    lastCheckedAt: new Date(NOW).toISOString(),
  });

  // Only the match, not every item on the page, and only its structured fields.
  expect(await t.query(api.mcp.getMatches, { apiKey: key, monitorId: id })).toEqual([
    { ...hut, matchedAt: new Date(NOW).toISOString() },
  ]);
});

test("the web flow saves the matches, not every item, as the first scan's history", async () => {
  const t = setup();
  const { asUser } = await seedUser(t, "a@example.com");
  const id = await asUser.mutation(api.monitors.create, { ...MONITOR, checkInterval: "1h" });
  const items = [{ title: "one" }, { title: "two" }];
  await asUser.mutation(api.monitors.saveScanResult, { id, schema: { items }, matchCount: 1, matches: [items[0]] });

  const rows = await t.run((ctx) => ctx.db.query("scrapeResults").collect());
  expect(rows.map((r) => r.matches)).toEqual([[items[0]]]);
});

test("a free user's MCP monitor gets every channel but texts, whatever their other monitors use", async () => {
  const t = setup();
  const { asUser, key } = await seedUser(t, "a@example.com");
  await asUser.mutation(api.monitors.create, { ...MONITOR, checkInterval: "1h", notificationChannels: ["telegram"] });

  // No channels given means "all of them". Free has no texts, so the list is
  // written out without them rather than left unset.
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect(monitor!.notificationChannels).toEqual(["email", "telegram", "discord", "push"]);
});

test("an item still matching on every check comes back once, dated from when it first matched", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  const hut = { title: "Clinton Hut 3 Feb", url: "https://example.com/3feb" };
  const newer = { title: "Mintaro Hut 4 Feb", url: "https://example.com/4feb" };
  await t.run(async (ctx) => {
    // The scheduler's full extract stores every current match, not only new ones.
    for (const [at, matches] of [[NOW, [hut]], [NOW + MINUTE, [hut, newer]], [NOW + 2 * MINUTE, [hut, newer]]] as const) {
      await ctx.db.insert("scrapeResults", { monitorId: id, matches: [...matches], totalItems: 5, hasNewMatches: true, scrapedAt: at });
    }
  });

  expect(await t.query(api.mcp.getMatches, { apiKey: key, monitorId: id })).toEqual([
    { ...newer, matchedAt: new Date(NOW + MINUTE).toISOString() },
    { ...hut, matchedAt: new Date(NOW).toISOString() },
  ]);
});

test("a user can hold at most 20 keys, so every key stays on the page that revokes it", async () => {
  const t = setup();
  const { asUser } = await seedUser(t, "a@example.com");
  for (let i = 1; i < 20; i++) await asUser.mutation(api.apiKeys.create, { name: `k${i}` });
  await expect(asUser.mutation(api.apiKeys.create, { name: "k20" })).rejects.toThrow(/20 API keys/);
  expect(await asUser.query(api.apiKeys.listMine, {})).toHaveLength(20);
});

// A first-scan alert must not let a match whose stock the page hid read as in stock.
test("a first scan's alert says when a match's stock was not shown", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, prompt: "in stock under NZ$100" });
  const cooler = { title: "Noctua NH-L9a-AM5", price: 89, inStock: null };
  await t.mutation(api.mcp.saveScanResult, {
    apiKey: key,
    id,
    schema: { items: [cooler], matchConditions: { priceMax: 100, inStockOnly: true } },
    matches: [cooler],
  });

  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  const job = jobs.find((j) => j.name.includes("sendInitialScanNotifications"));
  expect(job?.args[0]).toMatchObject({ stockNote: "Stock not shown on page for “Noctua NH-L9a-AM5”." });
});


// An agent decides what to do from the code, not by parsing English.
test("tool errors carry a code, a message and whether retrying may help", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  expect(await toolErrorOf(t.query(api.mcp.getMatches, { apiKey: key, monitorId: "nope" }))).toEqual({
    code: "not_found",
    message: "Monitor not found",
    retry: false,
  });
  for (let i = 0; i < 3; i++) await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  // The creation limit clears with time, so the same call works later.
  expect(await toolErrorOf(t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR }))).toMatchObject({
    code: "limit_reached",
    message: expect.stringMatching(/^Creation limit reached/),
    retry: true,
  });
  // The plan's monitor limit does not: only an upgrade or a delete clears it.
  vi.setSystemTime(NOW + 6 * 60 * MINUTE);
  expect(await toolErrorOf(t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR }))).toMatchObject({
    code: "limit_reached",
    message: expect.stringMatching(/Upgrade for more/),
    retry: false,
  });
  expect(await toolErrorOf(t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, url: "ftp://x.com" }))).toMatchObject({
    code: "invalid_url",
    retry: false,
  });
});

test("an agent can rename, re-prompt, slow down and pause a monitor", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  await t.run((ctx) => ctx.db.patch(id, { status: "active" }));

  await t.mutation(api.mcp.updateMonitor, {
    apiKey: key,
    monitorId: id,
    name: " Milford, Feb ",
    prompt: "any Feb start under $100",
    checkInterval: "5m",
    paused: true,
  });
  const monitor = await t.run((ctx) => ctx.db.get(id));
  // 5m is not on the free plan, so it is clamped as in the web app.
  expect(monitor).toMatchObject({ name: "Milford, Feb", prompt: "any Feb start under $100", checkInterval: "1h", status: "paused" });

  await t.mutation(api.mcp.updateMonitor, { apiKey: key, monitorId: id, paused: false });
  const resumed = await t.run((ctx) => ctx.db.get(id));
  expect(resumed?.status).toBe("active");
  // The inactivity job reads this as the owner being alive. An agent's resume
  // moves no session, so without it the monitor is paused again next run.
  expect(resumed?.lastResumedAt).toBe(NOW);
});

// The URL is the monitor's identity: its history and seen set describe that page.
test("changing a monitor's URL is refused, with how to do it instead", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  expect(await toolErrorOf(t.mutation(api.mcp.updateMonitor, { apiKey: key, monitorId: id, url: "https://example.com/other" }))).toEqual({
    code: "invalid_url",
    message: "A monitor's URL can't change. Delete it and create a new one.",
    retry: false,
  });
});

test("one key can neither edit nor delete another account's monitor", async () => {
  const t = setup();
  const owner = await seedUser(t, "a@example.com");
  const other = await seedUser(t, "b@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: owner.key, ...MONITOR });

  expect(await toolErrorOf(t.mutation(api.mcp.updateMonitor, { apiKey: other.key, monitorId: id, name: "mine" }))).toMatchObject({ code: "not_found" });
  expect(await toolErrorOf(t.mutation(api.mcp.deleteMonitor, { apiKey: other.key, monitorId: id }))).toMatchObject({ code: "not_found" });
  expect((await t.run((ctx) => ctx.db.get(id)))?.name).toBe("Milford");
});

test("deleting a monitor removes it and its history", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  await t.mutation(api.mcp.saveScanResult, { apiKey: key, id, schema: { items: [{ title: "x" }] }, matches: [] });

  await t.mutation(api.mcp.deleteMonitor, { apiKey: key, monitorId: id });
  expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  expect(await t.run((ctx) => ctx.db.query("scrapeResults").collect())).toEqual([]);
});

test("an agent can set stock and price alerts, and is told when the page is not a product page", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  await t.mutation(api.mcp.saveScanResult, {
    apiKey: key,
    id,
    schema: { items: [{ title: "Clinton Hut", url: "https://example.com/1" }, { title: "Mintaro Hut", url: "https://example.com/2" }] },
    matches: [],
  });

  const result = await t.mutation(api.mcp.updateMonitor, { apiKey: key, monitorId: id, alertOn: { backInStock: true } });
  expect((await t.run((ctx) => ctx.db.get(id)))?.alertOn).toEqual({ backInStock: true });
  expect(result.note).toMatch(/only run on a product page/);

  const product = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  await t.mutation(api.mcp.saveScanResult, { apiKey: key, id: product, schema: { items: [{ title: "Clinton Hut" }] }, matches: [] });
  expect((await t.mutation(api.mcp.updateMonitor, { apiKey: key, monitorId: product, alertOn: { backInStock: true } })).note).toBeUndefined();
});

test("create_monitor takes stock and price alerts, and guesses them from the prompt when left out", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const given = await t.mutation(api.mcp.createMonitor, {
    apiKey: key,
    ...MONITOR,
    alertOn: { priceBelow: { amount: 9500, currency: "NZD" } },
  });
  const guessed = await t.mutation(api.mcp.createMonitor, {
    apiKey: key,
    ...MONITOR,
    prompt: "The Noctua NH-L9a-AM5 is back in stock, under NZ$95.",
  });
  expect((await t.run((ctx) => ctx.db.get(given)))?.alertOn).toEqual({ priceBelow: { amount: 9500, currency: "NZD" } });
  expect((await t.run((ctx) => ctx.db.get(guessed)))?.alertOn).toEqual({
    backInStock: true,
    priceBelow: { amount: 9500, currency: "NZD" },
  });
  // A prompt with nothing to guess leaves alerts off, as before.
  const plain = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  expect((await t.run((ctx) => ctx.db.get(plain)))?.alertOn).toBeUndefined();
});

// Alerts the agent asked for that will never run must be said, not left silent.
test("a first scan says when the stock and price alerts it was given cannot run on the page", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, alertOn: { backInStock: true } });
  const result = await t.mutation(api.mcp.saveScanResult, {
    apiKey: key,
    id,
    schema: { items: [{ title: "Clinton Hut", url: "https://example.com/1" }, { title: "Mintaro Hut", url: "https://example.com/2" }] },
    matches: [],
  });
  expect(result).toEqual({ note: expect.stringMatching(/only run on a product page/) });
});

// Proxy reads cost credit. An agent retrying blocked shops in a loop must hit
// a wall at 5 a day per user, and the answer must say so.
test("preview gets 5 proxy attempts per user per day", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const other = await seedUser(t, "b@example.com");
  for (let i = 0; i < 5; i++) {
    expect(await t.mutation(api.mcp.claimPreviewProxy, { apiKey: key })).toEqual({ granted: true });
  }
  expect(await t.mutation(api.mcp.claimPreviewProxy, { apiKey: key })).toEqual({
    granted: false,
    reason: "This account has used its 5 proxy previews for today.",
  });
  // Another user's allowance is their own.
  expect(await t.mutation(api.mcp.claimPreviewProxy, { apiKey: other.key })).toEqual({ granted: true });

  vi.setSystemTime(NOW + 24 * 60 * MINUTE);
  expect(await t.mutation(api.mcp.claimPreviewProxy, { apiKey: key })).toEqual({ granted: true });
});

test("preview gets no proxy attempt once the fleet's proxy budget is spent", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const month = new Date(NOW).toISOString().slice(0, 7);
  await t.run((ctx) => ctx.db.insert("counters", { name: `fallback:calls:${month}`, value: 1_000_000 }));
  expect(await t.mutation(api.mcp.claimPreviewProxy, { apiKey: key })).toMatchObject({ granted: false });
});

const LISTING = {
  site: "argos.co.uk",
  url: "https://www.argos.co.uk/product/1",
  title: "Sony WH-1000XM5",
  price: 27999,
  currency: "GBP",
  inStock: true,
  label: "same",
};

async function searchesUsed(t: T, userId: string) {
  const row = await t.run((ctx) => ctx.db.query("userTiers").withIndex("by_userId", (q) => q.eq("userId", userId)).unique());
  return row?.productSearchCount ?? 0;
}

// An agent's search is the same paid call as the app's: same cap, same refund.
test("an agent's product search counts against the user's daily searches", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  vi.stubGlobal("fetch", async () => Response.json({ listings: [LISTING] }));
  const t = setup();
  const { key, userId } = await seedUser(t, "a@example.com");

  expect(await t.action(api.mcp.findProduct, { apiKey: key, query: "Sony WH-1000XM5", region: "GB" })).toEqual([LISTING]);
  expect(await searchesUsed(t, userId)).toBe(1);

  for (let i = 0; i < 4; i++) await t.action(api.mcp.findProduct, { apiKey: key, query: "Sony WH-1000XM5", region: "GB" });
  // Searches come back tomorrow, so retrying later works.
  expect(await toolErrorOf(t.action(api.mcp.findProduct, { apiKey: key, query: "Sony WH-1000XM5", region: "GB" }))).toMatchObject({
    code: "limit_reached",
    retry: true,
  });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("a failed agent search is refunded", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  vi.stubGlobal("fetch", async () => new Response("down", { status: 502 }));
  const t = setup();
  const { key, userId } = await seedUser(t, "a@example.com");
  expect(await toolErrorOf(t.action(api.mcp.findProduct, { apiKey: key, query: "Sony WH-1000XM5", region: "GB" }))).toMatchObject({
    code: "failed",
  });
  expect(await searchesUsed(t, userId)).toBe(0);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("an agent creates a product from the shop pages it picked", async () => {
  const t = setup();
  const { key, userId } = await seedUser(t, "a@example.com");
  const { productId, monitorIds } = await t.mutation(api.mcp.createProduct, {
    apiKey: key,
    title: "Sony WH-1000XM5",
    region: "GB",
    urls: ["https://www.argos.co.uk/product/1", "https://www.currys.co.uk/products/2"],
    alertOn: { backInStock: true },
  });
  const product = await t.run((ctx) => ctx.db.get(productId));
  expect(product).toMatchObject({ userId, name: "Sony WH-1000XM5", alertOn: { backInStock: true } });
  expect(product?.listings.map((l) => [l.site, l.state])).toEqual([
    ["argos.co.uk", "watching"],
    ["currys.co.uk", "watching"],
  ]);
  const monitors = await t.run((ctx) => Promise.all(monitorIds.map((id) => ctx.db.get(id))));
  expect(monitors.map((m) => [m?.groupId, m?.alertOn, m?.productTitle])).toEqual([
    [productId, { backInStock: true }, "Sony WH-1000XM5"],
    [productId, { backInStock: true }, "Sony WH-1000XM5"],
  ]);

  // A product with nothing to alert on would watch silently.
  expect(
    await toolErrorOf(t.mutation(api.mcp.createProduct, { apiKey: key, title: "x", region: "GB", urls: ["https://a.test/1"], alertOn: {} }))
  ).toMatchObject({ code: "failed", message: "Pick what to be alerted about." });
});

// One call for "what's new", instead of get_matches on every monitor.
test("recent matches cover every monitor, only what is new since then, and only the key's own", async () => {
  const t = setup();
  const { key, userId } = await seedUser(t, "a@example.com");
  const other = await seedUser(t, "b@example.com");
  const ram = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, name: "RAM" });
  const cooler = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, name: "Cooler" });
  const theirs = await t.mutation(api.mcp.createMonitor, { apiKey: other.key, ...MONITOR, name: "Theirs" });
  const old = { title: "Kingston kit", url: "https://shop.test/kingston" };
  const fresh = { title: "Noctua", url: "https://shop.test/noctua" };
  const since = NOW + 10 * MINUTE;
  await t.run(async (ctx) => {
    // Matched before `since` and still on the page after: not new.
    await ctx.db.insert("scrapeResults", { monitorId: ram, matches: [old], totalItems: 9, hasNewMatches: true, scrapedAt: NOW });
    // A full read from before rows recorded which matches were new.
    await ctx.db.insert("scrapeResults", { monitorId: ram, matches: [old], items: [old], totalItems: 9, hasNewMatches: true, scrapedAt: since + MINUTE });
    await ctx.db.patch(ram, { lastMatchAt: since + MINUTE });
    await ctx.db.insert("scrapeResults", { monitorId: cooler, matches: [fresh], totalItems: 9, hasNewMatches: true, scrapedAt: since + 2 * MINUTE });
    await ctx.db.patch(cooler, { lastMatchAt: since + 2 * MINUTE });
    await ctx.db.insert("scrapeResults", { monitorId: theirs, matches: [fresh], totalItems: 9, hasNewMatches: true, scrapedAt: since + 2 * MINUTE });
    await ctx.db.patch(theirs, { lastMatchAt: since + 2 * MINUTE });
  });


  expect(await t.query(api.mcp.getRecentMatches, { apiKey: key, since: new Date(since).toISOString() })).toEqual([
    { ...fresh, monitorId: cooler, monitorName: "Cooler", matchedAt: new Date(since + 2 * MINUTE).toISOString() },
  ]);
});

test("recent matches leave out a product's listings, which never send match alerts", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const { monitorIds } = await t.mutation(api.mcp.createProduct, {
    apiKey: key,
    title: "Sony WH-1000XM5",
    region: "GB",
    urls: ["https://www.argos.co.uk/product/1"],
    alertOn: { backInStock: true },
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("scrapeResults", { monitorId: monitorIds[0]!, matches: [{ title: "Case" }], totalItems: 9, hasNewMatches: true, scrapedAt: NOW });
    await ctx.db.patch(monitorIds[0]!, { lastMatchAt: NOW });
  });
  expect(await t.query(api.mcp.getRecentMatches, { apiKey: key, since: new Date(NOW - MINUTE).toISOString() })).toEqual([]);
});

// Each monitor read costs a history read; one call must stay bounded.
test("recent matches read at most the 20 monitors that matched most recently", async () => {
  const t = setup();
  const { key, userId } = await seedUser(t, "a@example.com");
  await t.run(async (ctx) => {
    for (let i = 0; i < 21; i++) {
      const id = await ctx.db.insert("monitors", {
        userId, name: `m${i}`, url: `https://shop.test/${i}`, prompt: "x", status: "active", checkInterval: "1h",
        matchCount: 1, lastMatchAt: NOW + i, createdAt: NOW, updatedAt: NOW,
      });
      await ctx.db.insert("scrapeResults", { monitorId: id, matches: [{ title: `item ${i}` }], totalItems: 1, hasNewMatches: true, scrapedAt: NOW + i });
    }
  });
  const recent = await t.query(api.mcp.getRecentMatches, { apiKey: key, since: new Date(NOW).toISOString(), limit: 100 });
  expect(recent).toHaveLength(20);
  expect(recent.at(-1)?.monitorName).toBe("m1");
});

// Previews have their own hourly bucket. On the monitors' escalation budget,
// a few busy agents could starve real monitors of their proxy retries.
test("previews get 20 proxy attempts an hour across all users, apart from monitors' budget", async () => {
  const t = setup();
  const keys = [];
  for (let i = 0; i < 5; i++) keys.push((await seedUser(t, `u${i}@example.com`)).key);
  for (let i = 0; i < 20; i++) {
    expect(await t.mutation(api.mcp.claimPreviewProxy, { apiKey: keys[i % 5]! })).toEqual({ granted: true });
  }
  expect(await t.mutation(api.mcp.claimPreviewProxy, { apiKey: keys[4]! })).toMatchObject({ granted: false });

  const hour = new Date(NOW).toISOString().slice(0, 13);
  const escalations = await t.run((ctx) =>
    ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", `fallback:escalations:${hour}`)).unique()
  );
  expect(escalations).toBeNull();
});

test("an agent files what it creates in a folder, and can move it out", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const { folderId } = await t.mutation(api.mcp.createFolder, { apiKey: key, name: "PC build" });
  // Asked again in a later session, the same name is the same folder.
  expect(await t.mutation(api.mcp.createFolder, { apiKey: key, name: "pc build" })).toEqual({ folderId, name: "PC build" });

  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, folderId });
  const { productId } = await t.mutation(api.mcp.createProduct, {
    apiKey: key, title: "Sony WH-1000XM5", region: "GB", urls: ["https://www.argos.co.uk/product/1"],
    alertOn: { backInStock: true }, folderId,
  });
  expect((await t.run((ctx) => ctx.db.get(productId)))?.folderId).toBe(folderId);
  const listed = (await t.query(api.mcp.listMonitors, { apiKey: key })).find((m) => m.id === id);
  expect(listed?.folder).toBe("PC build");

  await t.mutation(api.mcp.updateMonitor, { apiKey: key, monitorId: id, folderId: null });
  expect((await t.run((ctx) => ctx.db.get(id)))?.folderId).toBeUndefined();
});

test("an agent cannot file into another account's folder", async () => {
  const t = setup();
  const owner = await seedUser(t, "a@example.com");
  const other = await seedUser(t, "b@example.com");
  const { folderId } = await t.mutation(api.mcp.createFolder, { apiKey: owner.key, name: "PC build" });
  expect(await toolErrorOf(t.mutation(api.mcp.createMonitor, { apiKey: other.key, ...MONITOR, folderId }))).toMatchObject({
    code: "not_found",
    message: "Folder not found",
  });
  // All or nothing: the refused monitor is not left behind.
  expect(await t.query(api.mcp.listMonitors, { apiKey: other.key })).toEqual([]);
});

// A sold-out item the first scan saw must be rechecked, or its restock never alerts.
test("the first scan queues sold-out entries for rechecks when the prompt asks for stock", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  await t.mutation(api.mcp.saveScanResult, {
    apiKey: key,
    id,
    schema: {
      items: [
        { title: "Kingston", url: "https://shop.test/kingston", price: 199, inStock: false },
        { title: "Corsair", url: "https://shop.test/corsair", price: 199, inStock: true },
        // Sold out, but not what the prompt wants: rechecking it is wasted.
        { title: "Kingston", url: "https://shop.test/kingston-case", price: 500, inStock: false },
      ],
      matchConditions: { inStockOnly: true, priceMax: 220 },
    },
    matches: [],
  });
  expect((await t.run((ctx) => ctx.db.get(id)))?.soldOutKeys).toEqual(["shop.test/kingston"]);
});

// A full re-read stores every current match. Only the ones it found new are news.
test("recent matches skip what a re-read found again", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const ram = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, name: "RAM" });
  const old = { title: "Kingston kit", url: "https://shop.test/kingston" };
  const fresh = { title: "Corsair kit", url: "https://shop.test/corsair" };
  await t.run(async (ctx) => {
    await ctx.db.insert("scrapeResults", {
      monitorId: ram, matches: [old, fresh], items: [old, fresh], newMatchKeys: ["shop.test/corsair"], totalItems: 9, hasNewMatches: true, scrapedAt: NOW,
    });
    await ctx.db.patch(ram, { lastMatchAt: NOW });
  });
  expect(await t.query(api.mcp.getRecentMatches, { apiKey: key, since: new Date(NOW - MINUTE).toISOString() })).toEqual([
    { ...fresh, monitorId: ram, monitorName: "RAM", matchedAt: new Date(NOW).toISOString() },
  ]);
  // get_matches still lists both: both are on the page now.
  expect(await t.query(api.mcp.getMatches, { apiKey: key, monitorId: ram })).toHaveLength(2);
});

async function previewCounters(t: T) {
  return (await t.run((ctx) => ctx.db.query("counters").collect())).map((c) => c.name).filter((n) => n.startsWith("previewProxy:")).sort();
}

// The counters table must not grow a row per user per day for good.
test("preview proxy counters from earlier days and hours are swept", async () => {
  const t = setup();
  const { key, userId } = await seedUser(t, "a@example.com");
  await t.mutation(api.mcp.claimPreviewProxy, { apiKey: key });
  vi.setSystemTime(NOW + 25 * 60 * MINUTE);
  await t.mutation(api.mcp.claimPreviewProxy, { apiKey: key });
  const now = new Date(NOW + 25 * 60 * MINUTE).toISOString();
  expect(await previewCounters(t)).toEqual([`previewProxy:${userId}:${now.slice(0, 10)}`, `previewProxy:hour:${now.slice(0, 13)}`].sort());
});

// Erasure: a deleted account's id must not stay behind in a counter's name.
test("deleting an account removes its preview proxy counter", async () => {
  const t = setup();
  const { key, userId } = await seedUser(t, "a@example.com");
  await t.mutation(api.mcp.claimPreviewProxy, { apiKey: key });
  await t.run((ctx) => deleteAllUserData(ctx, userId, "a@example.com"));
  expect((await previewCounters(t)).filter((n) => n.includes(userId))).toEqual([]);
});

// A restock alerts again. "What's new" must date it from that alert, not the first.
test("recent matches date an item from its latest alert", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const ram = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, name: "RAM" });
  const kit = { title: "Kingston kit", url: "https://shop.test/kingston" };
  await t.run(async (ctx) => {
    await ctx.db.insert("scrapeResults", { monitorId: ram, matches: [kit], totalItems: 9, hasNewMatches: true, scrapedAt: NOW - 10 * 24 * 60 * MINUTE });
    await ctx.db.insert("scrapeResults", { monitorId: ram, matches: [kit], totalItems: 9, hasNewMatches: true, scrapedAt: NOW });
    await ctx.db.patch(ram, { lastMatchAt: NOW });
  });
  // Both alerts fall inside the window; the answer gives the restock's time.
  expect(await t.query(api.mcp.getRecentMatches, { apiKey: key, since: new Date(NOW - 11 * 24 * 60 * MINUTE).toISOString() })).toEqual([
    { ...kit, monitorId: ram, monitorName: "RAM", matchedAt: new Date(NOW).toISOString() },
  ]);
});

// A product's listings share the product's alerts and interval. One listing
// changed alone would alert unlike the rest, and the product page would not show it.
test("an agent cannot change alerts or interval on one listing of a product", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const { monitorIds } = await t.mutation(api.mcp.createProduct, {
    apiKey: key, title: "Sony WH-1000XM5", region: "GB", urls: ["https://www.argos.co.uk/product/1"], alertOn: { backInStock: true },
  });
  for (const change of [{ alertOn: { priceDrop: true } }, { checkInterval: "6h" as const }]) {
    expect(await toolErrorOf(t.mutation(api.mcp.updateMonitor, { apiKey: key, monitorId: monitorIds[0]!, ...change }))).toMatchObject({
      code: "failed",
      message: expect.stringMatching(/part of a product/),
    });
  }
  expect((await t.run((ctx) => ctx.db.get(monitorIds[0]!)))?.alertOn).toEqual({ backInStock: true });
});

// A product's folder lives on the product. Its listings must show it too, or
// an agent that filed the product sees it unfiled.
test("list_monitors shows a product listing's folder", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const { folderId } = await t.mutation(api.mcp.createFolder, { apiKey: key, name: "PC build" });
  await t.mutation(api.mcp.createProduct, {
    apiKey: key, title: "Noctua", region: "NZ", urls: ["https://computerlounge.co.nz/products/noctua"], alertOn: { backInStock: true }, folderId,
  });
  expect((await t.query(api.mcp.listMonitors, { apiKey: key })).map((m) => m.folder)).toEqual(["PC build"]);
});

// A 15-minute monitor writes about 96 rows a day, most with no match. An alert
// from early in the window must not fall past the rows read.
test("recent matches find an alert 150 checks back", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const ram = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, name: "RAM" });
  const kit = { title: "Kingston kit", url: "https://shop.test/kingston" };
  await t.run(async (ctx) => {
    await ctx.db.insert("scrapeResults", { monitorId: ram, matches: [kit], totalItems: 9, hasNewMatches: true, scrapedAt: NOW });
    for (let i = 1; i <= 150; i++) {
      await ctx.db.insert("scrapeResults", { monitorId: ram, matches: [], totalItems: 9, hasNewMatches: false, scrapedAt: NOW + i * 15 * MINUTE });
    }
    await ctx.db.patch(ram, { lastMatchAt: NOW });
  });
  expect(await t.query(api.mcp.getRecentMatches, { apiKey: key, since: new Date(NOW - MINUTE).toISOString() })).toHaveLength(1);
});

// The default answer size is the same as get_matches.
test("recent matches return 20 by default", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const ram = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, name: "RAM" });
  await t.run(async (ctx) => {
    const matches = Array.from({ length: 30 }, (_, i) => ({ title: `kit ${i}`, url: `https://shop.test/${i}` }));
    await ctx.db.insert("scrapeResults", { monitorId: ram, matches, totalItems: 30, hasNewMatches: true, scrapedAt: NOW });
    await ctx.db.patch(ram, { lastMatchAt: NOW });
  });
  expect(await t.query(api.mcp.getRecentMatches, { apiKey: key, since: new Date(NOW - MINUTE).toISOString() })).toHaveLength(20);
});

// Ticking "In stock only" on a page already read must queue what is sold out
// now, or those entries, already seen, are never judged again.
test("turning on in-stock-only queues the sold-out entries already read", async () => {
  const t = setup();
  const { key, asUser } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  const items = [{ title: "Kingston", url: "https://shop.test/kingston", price: 199, inStock: false }];
  await t.run((ctx) => ctx.db.patch(id, { status: "active", schema: { items, matchConditions: {} } }));
  await asUser.mutation(api.monitors.update, { id, schema: { items, matchConditions: { inStockOnly: true } } });
  expect((await t.run((ctx) => ctx.db.get(id)))?.soldOutKeys).toEqual(["shop.test/kingston"]);
});

// The first scan is still running, so the pause cannot take. Saying it did
// would leave the user believing a monitor is paused that goes on to alert.
test("pausing a monitor mid-scan is refused, with when to try again", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  expect(await toolErrorOf(t.mutation(api.mcp.updateMonitor, { apiKey: key, monitorId: id, paused: true }))).toMatchObject({
    code: "failed",
    retry: true,
  });
  // The scan saves the old prompt's reading when it ends, over the re-read.
  expect(await toolErrorOf(t.mutation(api.mcp.updateMonitor, { apiKey: key, monitorId: id, prompt: "any March start" }))).toMatchObject({
    code: "failed",
    retry: true,
  });
  expect((await t.run((ctx) => ctx.db.get(id)))?.prompt).toBe(MONITOR.prompt);
});

// An agent fixes a bad link by picking another page, not by retrying.
test("create_product with a link that can't be watched says invalid_url", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  expect(
    await toolErrorOf(t.mutation(api.mcp.createProduct, { apiKey: key, title: "x", region: "GB", urls: ["ftp://a.test/1"], alertOn: { backInStock: true } }))
  ).toMatchObject({ code: "invalid_url", retry: false });
});

// A search that failed on our side is refunded and may work on a retry.
test("a failed agent search says retrying may help", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  vi.stubGlobal("fetch", async () => new Response("down", { status: 502 }));
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  expect(await toolErrorOf(t.action(api.mcp.findProduct, { apiKey: key, query: "Sony WH-1000XM5", region: "GB" }))).toMatchObject({
    code: "failed",
    retry: true,
  });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// An agent cannot press Rescan. A new prompt must reach the page's matching
// at the next check, not at the 14-day re-read.
test("a new prompt over MCP makes the next check re-read the page", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  await t.run((ctx) =>
    ctx.db.patch(id, {
      status: "active", lastAiExtractAt: NOW, contentFingerprint: "page-1",
      candidateKeys: ["example.com/feb"], soldOutKeys: ["example.com/feb"], soldOutTextHashes: ["h"],
    })
  );
  await t.mutation(api.mcp.updateMonitor, { apiKey: key, monitorId: id, prompt: "any March start date" });
  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect([monitor?.lastAiExtractAt, monitor?.contentFingerprint]).toEqual([0, undefined]);
  // The old prompt's seen set and queue describe other entries. Kept, the
  // quick check after the re-read would announce its matches a second time.
  expect([monitor?.candidateKeys, monitor?.soldOutKeys, monitor?.soldOutTextHashes]).toEqual([undefined, undefined, undefined]);

  // A rename, or the same prompt sent again, re-reads nothing: that would be
  // a paid call for no reason.
  await t.run((ctx) => ctx.db.patch(id, { lastAiExtractAt: NOW }));
  await t.mutation(api.mcp.updateMonitor, { apiKey: key, monitorId: id, name: "Milford, March", prompt: "any March start date" });
  expect((await t.run((ctx) => ctx.db.get(id)))?.lastAiExtractAt).toBe(NOW);
});

// Agents have no move-product tool. Filing one of its listings files the product.
test("filing a product's listing files the product", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const { folderId } = await t.mutation(api.mcp.createFolder, { apiKey: key, name: "PC build" });
  const { productId, monitorIds } = await t.mutation(api.mcp.createProduct, {
    apiKey: key, title: "Noctua", region: "NZ", urls: ["https://computerlounge.co.nz/products/noctua"], alertOn: { backInStock: true },
  });
  await t.mutation(api.mcp.updateMonitor, { apiKey: key, monitorId: monitorIds[0]!, folderId });
  expect((await t.run((ctx) => ctx.db.get(productId)))?.folderId).toBe(folderId);
});

// The block lifts tomorrow. Mentioning a URL as advice does not make it a bad URL.
test("a search blocked for the day says retry, not invalid_url", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const t = setup();
  const { key, userId } = await seedUser(t, "a@example.com");
  const day = new Date(NOW).toISOString().slice(0, 10);
  await t.run((ctx) => ctx.db.insert("userTiers", { userId, tier: "free", productSearchDay: day, productSearchCount: 0, productSearchAttempts: 99, updatedAt: NOW }));
  expect(await toolErrorOf(t.action(api.mcp.findProduct, { apiKey: key, query: "Sony WH-1000XM5", region: "GB" }))).toEqual({
    code: "failed",
    message: "Search isn't working for you today. Paste a URL instead, or try again tomorrow.",
    retry: true,
  });
  vi.unstubAllEnvs();
});

// Costco answers a direct read with an empty page. Over MCP, as on the
// dashboard, a known proxy site's first scan goes straight to the proxy.
test("a first scan over MCP claims the proxy only for a site known to need it", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const costco = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, url: "https://www.costco.com/bose.html" });
  const plain = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  expect(await t.mutation(api.mcp.claimFirstScanProxy, { apiKey: key, id: costco })).toBe("https://www.costco.com/bose.html");
  // One claim per monitor ever.
  expect(await t.mutation(api.mcp.claimFirstScanProxy, { apiKey: key, id: costco })).toBeNull();
  expect(await t.mutation(api.mcp.claimFirstScanProxy, { apiKey: key, id: plain })).toBeNull();
});

// Three listings of one product shared one name in the list, and nothing tied
// them together. An agent needs the shop, the product and the alerts to tell
// them apart and to check what it set.
test("list_monitors shows each monitor's prompt, alerts, shop and product", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const standalone = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR, alertOn: { priceDrop: true } });
  const { productId, monitorIds } = await t.mutation(api.mcp.createProduct, {
    apiKey: key,
    title: "Gigabyte RX 9060 XT",
    region: "NZ",
    urls: ["https://www.pbtech.co.nz/product/1", "https://www.thewarehouse.co.nz/p/2"],
    alertOn: { backInStock: true },
  });

  const listed = await t.query(api.mcp.listMonitors, { apiKey: key });
  const byId = new Map(listed.map((m) => [m.id, m]));
  expect(byId.get(standalone)).toMatchObject({
    prompt: MONITOR.prompt,
    shop: "example.com",
    alertOn: { priceDrop: true },
    productId: null,
  });
  expect(monitorIds.map((id) => [byId.get(id)?.shop, byId.get(id)?.productId, byId.get(id)?.alertOn])).toEqual([
    ["pbtech.co.nz", productId, { backInStock: true }],
    ["thewarehouse.co.nz", productId, { backInStock: true }],
  ]);
});

// It returned only the id, so an agent could not tell what had been saved,
// such as an interval the plan lowered.
test("update_monitor returns the monitor as saved", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  await t.run((ctx) => ctx.db.patch(id, { status: "active" }));

  const result = await t.mutation(api.mcp.updateMonitor, {
    apiKey: key,
    monitorId: id,
    name: "Milford, Feb",
    checkInterval: "5m",
    alertOn: { priceBelow: { amount: 9500, currency: "NZD" } },
  });
  const [listed] = await t.query(api.mcp.listMonitors, { apiKey: key });
  expect(result).toMatchObject({ ...listed, name: "Milford, Feb", checkInterval: "1h", alertOn: { priceBelow: { amount: 9500, currency: "NZD" } } });
});

test("get_product returns each shop's last price, stock and check time", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const { folderId } = await t.mutation(api.mcp.createFolder, { apiKey: key, name: "PC build" });
  const { productId, monitorIds } = await t.mutation(api.mcp.createProduct, {
    apiKey: key,
    title: "Gigabyte RX 9060 XT",
    region: "NZ",
    urls: ["https://www.pbtech.co.nz/product/1", "https://www.thewarehouse.co.nz/p/2"],
    alertOn: { priceBelow: { amount: 80000, currency: "NZD" } },
    folderId,
  });
  const [pbtech, warehouse] = monitorIds;
  await t.run(async (ctx) => {
    await ctx.db.patch(pbtech!, { status: "active", lastCheckedAt: NOW - MINUTE, lastSeen: { inStock: false, price: 86135, currency: "NZD" } });
    await ctx.db.patch(warehouse!, { status: "error", lastError: "Blocked by a bot check" });
  });

  expect(await t.query(api.mcp.getProduct, { apiKey: key, productId })).toEqual({
    id: productId,
    name: "Gigabyte RX 9060 XT",
    region: "NZ",
    alertOn: { priceBelow: { amount: 80000, currency: "NZD" } },
    checkInterval: "1h",
    folder: "PC build",
    listings: [
      {
        monitorId: pbtech,
        shop: "pbtech.co.nz",
        url: "https://www.pbtech.co.nz/product/1",
        status: "active",
        inStock: false,
        price: 86135,
        currency: "NZD",
        lastCheckedAt: new Date(NOW - MINUTE).toISOString(),
        lastError: null,
      },
      {
        monitorId: warehouse,
        shop: "thewarehouse.co.nz",
        url: "https://www.thewarehouse.co.nz/p/2",
        status: "error",
        inStock: null,
        price: null,
        currency: null,
        lastCheckedAt: null,
        lastError: "Blocked by a bot check",
      },
    ],
  });
});

test("get_product refuses another account's product and a malformed id", async () => {
  const t = setup();
  const owner = await seedUser(t, "a@example.com");
  const other = await seedUser(t, "b@example.com");
  const { productId } = await t.mutation(api.mcp.createProduct, {
    apiKey: owner.key, title: "x", region: "NZ", urls: ["https://www.pbtech.co.nz/product/1"], alertOn: { backInStock: true },
  });
  expect(await toolErrorOf(t.query(api.mcp.getProduct, { apiKey: other.key, productId }))).toMatchObject({ code: "not_found" });
  expect(await toolErrorOf(t.query(api.mcp.getProduct, { apiKey: owner.key, productId: "nope" }))).toMatchObject({ code: "not_found" });
});

// Prod, 14/11/2026: a PriceMe page in a product matched eBay listings of
// other cards. A product already compares shops, so a comparison page in it
// only adds a second, worse reading of the same offers.
test("create_product refuses a price comparison site, with what to do instead", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  expect(
    await toolErrorOf(
      t.mutation(api.mcp.createProduct, {
        apiKey: key,
        title: "Gigabyte RX 9060 XT",
        region: "NZ",
        urls: ["https://www.pbtech.co.nz/product/1", "https://www.priceme.co.nz/Gigabyte-RX-9060-XT/p-1.aspx"],
        alertOn: { backInStock: true },
      })
    )
  ).toEqual({
    code: "invalid_url",
    message: expect.stringMatching(/priceme\.co\.nz is a price comparison site.*each shop's own link/),
    retry: false,
  });
  expect(await t.run((ctx) => ctx.db.query("monitors").collect())).toEqual([]);
});

// Prod, 14/11/2026: find_product offered a PriceMe page at NZ$729 "in stock"
// while the page said no shop sold the card.
test("find_product leaves out price comparison sites", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const priceme = { ...LISTING, site: "priceme.co.nz", url: "https://www.priceme.co.nz/x/p-1.aspx", price: 72900, inStock: true };
  vi.stubGlobal("fetch", async () => Response.json({ listings: [priceme, LISTING] }));
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  expect(await t.action(api.mcp.findProduct, { apiKey: key, query: "Sony WH-1000XM5", region: "GB" })).toEqual([LISTING]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// A standalone comparison page keeps working on its prompt, which can ask for
// "lowest in-stock price under $300". Its price alert would read a shop's
// offer as the product, so it is off, and the agent is told why.
test("a stock or price alert on a comparison page says only prompt alerts run there", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, {
    apiKey: key, url: "https://pricespy.co.nz/product.php?p=7327471", prompt: "lowest in-stock price under $380", name: "Ryzen 5 7600",
  });
  await t.mutation(api.mcp.saveScanResult, { apiKey: key, id, schema: { items: [{ title: "AMD Ryzen 5 7600", price: 46198 }] }, matches: [] });
  const result = await t.mutation(api.mcp.updateMonitor, {
    apiKey: key, monitorId: id, alertOn: { priceBelow: { amount: 38000, currency: "NZD" } },
  });
  expect(result.note).toMatch(/price comparison page.*only prompt alerts/i);
});

// The quick checks that follow count what the first scan passed as matches.
test("a first scan records which entries it passed, and a new prompt forgets them", async () => {
  const t = setup();
  const { key } = await seedUser(t, "a@example.com");
  const id = await t.mutation(api.mcp.createMonitor, { apiKey: key, ...MONITOR });
  const hut = { title: "Clinton Hut 3 Feb", url: "https://example.com/3feb" };
  await t.mutation(api.mcp.saveScanResult, { apiKey: key, id, schema: { items: [hut, { title: "Mintaro" }] }, matches: [hut] });
  expect((await t.run((ctx) => ctx.db.get(id)))?.passedKeys).toEqual(["example.com/3feb"]);

  // The old prompt's prices would make the re-read's silent seed judge entries again.
  await t.run((ctx) => ctx.db.patch(id, { status: "active", candidatePrices: [{ key: "example.com/3feb", price: 92 }] }));
  await t.mutation(api.mcp.updateMonitor, { apiKey: key, monitorId: id, prompt: "any March start" });
  const changed = await t.run((ctx) => ctx.db.get(id));
  expect(changed?.passedKeys).toBeUndefined();
  expect(changed?.candidatePrices).toBeUndefined();
});

// An old browser bundle saves a first scan without its matches. An empty
// list would claim the scan passed nothing.
test("a first scan saved without its matches leaves passedKeys unset", async () => {
  const t = setup();
  const { asUser } = await seedUser(t, "a@example.com");
  const id = await asUser.mutation(api.monitors.create, { ...MONITOR, checkInterval: "1h" });
  await asUser.mutation(api.monitors.saveScanResult, { id, schema: { items: [{ title: "one" }] }, matchCount: 1 });
  expect((await t.run((ctx) => ctx.db.get(id)))?.passedKeys).toBeUndefined();
});
