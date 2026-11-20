/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, components, internal } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";
import type { Doc } from "./_generated/dataModel";
import { isBlockedError, isProxyFirstHost, MAX_RETRIES, PROXY_REPROBE_EVERY } from "./shared";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const NOW = Date.now();
const COSTCO = "https://www.costco.com/p/-/bose-quietcomfort-sc-headphones-2nd-gen/4201038052";

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

async function insert(t: ReturnType<typeof setup>, url: string, extra: Partial<Doc<"monitors">> = {}) {
  return t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1", name: "watch", url, prompt: "in stock", status: "active", checkInterval: "1h",
      matchCount: 0, lastAiExtractAt: NOW, nextCheckAt: 0, checkCount: 1, createdAt: NOW, updatedAt: NOW,
      schema: { items: [], matchConditions: {} }, ...extra,
    })
  );
}

/** Run one scheduler pass and return the body of each quick-check request it sent. */
async function quickCheckBodies(t: ReturnType<typeof setup>) {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/quick-check")) {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ accessible: true, contentHash: "page-1", candidates: [], totalEntries: 1 });
    }
    return new Response("not mocked", { status: 500 });
  });
  await t.action(internal.scheduler.runScheduledChecks, {});
  return bodies;
}

// Costco serves our browser an empty page, never a CAPTCHA, so it never read
// as blocked and every retry went direct and failed the same way.
test("costco.com and its subdomains are proxy-first, look-alikes are not", () => {
  expect(isProxyFirstHost(COSTCO)).toBe(true);
  expect(isProxyFirstHost("https://costco.com/x")).toBe(true);
  expect(isProxyFirstHost("https://notcostco.com/x")).toBe(false);
  expect(isProxyFirstHost("https://www.costco.com.evil.test/x")).toBe(false);
  expect(isProxyFirstHost("not a url")).toBe(false);
});

// A page that is briefly empty is not a block. Counted as one, a working paid
// monitor would move to the proxy, take the 6-hour floor and could be parked.
test("an empty page does not count as a block", () => {
  expect(
    isBlockedError("Page inaccessible — no meaningful content found. The page may be down or require JavaScript that couldn't load.")
  ).toBe(false);
});

const EMPTY = "Page inaccessible — no meaningful content found. The page may be down or require JavaScript that couldn't load.";

// Prod, 18/11/2026: a Harvey Norman monitor read once, then got an empty page
// four times running and its owner deleted it. Costco did the same until it
// was listed by hand. A site that answers our browser with nothing never
// reads as blocked, so nothing ever tried the proxy.
test("a page that came back empty is retried through the proxy", async () => {
  const t = setup();
  await insert(t, "https://shop.test/empty", { retryCount: 1, lastError: EMPTY });
  const bodies = await quickCheckBodies(t);
  expect(bodies[0]?.useProxy).toBe(true);
});

test("a site the proxy can read after an empty page stays on the proxy", async () => {
  const t = setup();
  const id = await insert(t, "https://shop.test/empty", { retryCount: 1, lastError: EMPTY });
  await quickCheckBodies(t);
  expect((await t.run((ctx) => ctx.db.get(id)))?.proxyPreferred).toBe(true);
});

// A page that is down is also empty, and the proxy cannot fix that. Two paid
// attempts on the retry ladder is the whole budget: the 6-hourly recovery
// lane goes back to free direct fetches.
test("an empty page is not sent to the proxy on the recovery lane", async () => {
  const t = setup();
  await insert(t, "https://shop.test/empty", { status: "error", retryCount: MAX_RETRIES, lastError: EMPTY });
  const bodies = await quickCheckBodies(t);
  expect(bodies[0]?.url).toBe("https://shop.test/empty");
  expect(bodies[0]?.useProxy).toBeUndefined();
});

const SLOW = "Page took too long to load. The site may be slow or blocking automated access.";
const BLOCKED = "Site is blocking automated access: HTTP 403. Try a different URL or check if the site requires login.";

// One slow load, perhaps on a busy scraper, reads as a block because of its
// wording. The proxy retry then succeeded and marked the site proxy-only: a
// 15-minute monitor dropped to every 6 hours for about two days, unannounced.
test("one slow page load does not move a monitor onto the proxy for good", async () => {
  const t = setup();
  const id = await insert(t, "https://shop.test/slow", { retryCount: 1, lastError: SLOW, checkInterval: "15m" });
  const bodies = await quickCheckBodies(t);
  // The retry itself may still use the proxy: a tarpit is one way to block.
  expect(bodies[0]?.useProxy).toBe(true);
  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect(monitor?.proxyPreferred).not.toBe(true);
  expect(monitor!.nextCheckAt! - Date.now()).toBeLessThan(16 * 60_000);
});

test("a real block that the proxy gets past does move it onto the proxy", async () => {
  const t = setup();
  const id = await insert(t, "https://shop.test/blocked", { retryCount: 1, lastError: BLOCKED });
  await quickCheckBodies(t);
  expect((await t.run((ctx) => ctx.db.get(id)))?.proxyPreferred).toBe(true);
});

test("a proxy-first site's first scheduled check goes through the proxy", async () => {
  const t = setup();
  await insert(t, COSTCO);
  await insert(t, "https://shop.test/plain");
  const bodies = await quickCheckBodies(t);
  expect(bodies.find((b) => b.url === COSTCO)?.useProxy).toBe(true);
  expect(bodies.find((b) => b.url === "https://shop.test/plain")?.useProxy).toBeUndefined();
});

// The periodic direct re-probe exists to let a site drop off the proxy. A
// listed site is on it by our decision, so a direct probe is a wasted check.
test("a proxy-first site is never re-probed direct", async () => {
  const t = setup();
  await insert(t, COSTCO, { proxyPreferred: true, checkCount: PROXY_REPROBE_EVERY - 1 });
  const bodies = await quickCheckBodies(t);
  expect(bodies[0]?.useProxy).toBe(true);
});

// The hourly escalation cap is a sign of fleet-wide failure. A listed site's
// checks are routine, so a spent cap must not push them back to direct.
test("a proxy-first check is not an escalation, so the hourly cap does not stop it", async () => {
  const t = setup();
  await insert(t, COSTCO);
  const hour = new Date().toISOString().slice(0, 13);
  await t.run((ctx) => ctx.db.insert("counters", { name: `fallback:escalations:${hour}`, value: 1_000_000 }));
  const bodies = await quickCheckBodies(t);
  expect(bodies[0]?.useProxy).toBe(true);
});

// Every proxied check costs Scrapfly credit, so a listed site must take the
// same 6-hour floor as any other proxy-only site.
test("a proxy-first site that reads through the proxy becomes proxy-preferred", async () => {
  const t = setup();
  const id = await insert(t, COSTCO);
  await quickCheckBodies(t);
  expect((await t.run((ctx) => ctx.db.get(id)))?.proxyPreferred).toBe(true);
});

test("a first scan on a proxy-first site goes straight to the proxy", async () => {
  const t = setup();
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: { model: "user", data: { name: "A Person", email: "a@example.com", emailVerified: true, createdAt: NOW, updatedAt: NOW } },
  })) as { _id: string };
  const owner = t.withIdentity({ subject: user._id, email: "a@example.com" });
  const id = await owner.mutation(api.monitors.create, { url: COSTCO, prompt: "in stock", name: "Bose", checkInterval: "24h" });
  expect(await owner.mutation(api.monitors.claimFirstScanProxy, { id, knownHost: true })).toBe(COSTCO);
});

// Faster checks can only be sold where we can deliver them: a proxy-only site
// checks every 6 hours on any plan, and paying users already have speed.
test("the Sprint offer goes to Free users on sites we can check fast", async () => {
  const { sprintOfferTo } = await import("./shared");
  const url = "https://shop.test/x";
  expect(sprintOfferTo("free", { userId: "u", url, proxyPreferred: undefined })).toEqual({ offerSprintTo: "u" });
  expect(sprintOfferTo("free", { userId: "u", url, proxyPreferred: true })).toEqual({});
  expect(sprintOfferTo("free", { userId: "u", url: COSTCO })).toEqual({});
  expect(sprintOfferTo("sprint", { userId: "u", url, proxyPreferred: undefined })).toEqual({});
  expect(sprintOfferTo("pro", { userId: "u", url })).toEqual({});
});
