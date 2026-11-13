/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, components, internal } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";
import type { Doc } from "./_generated/dataModel";
import { isBlockedError, isProxyFirstHost, PROXY_REPROBE_EVERY } from "./shared";

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

// An empty page is how Akamai-style protection blocks us. Read as a block, the
// retry goes through the proxy instead of failing direct again.
test("an empty page counts as a block", () => {
  expect(
    isBlockedError("Page inaccessible — no meaningful content found. The page may be down or require JavaScript that couldn't load.")
  ).toBe(true);
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

test("a retry after an empty page goes through the proxy", async () => {
  const t = setup();
  await insert(t, "https://shop.test/akamai", {
    retryCount: 1,
    lastError: "Page inaccessible — no meaningful content found. The page may be down or require JavaScript that couldn't load.",
  });
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
  expect(sprintOfferTo("free", { userId: "u", proxyPreferred: undefined })).toEqual({ offerSprintTo: "u" });
  expect(sprintOfferTo("free", { userId: "u", proxyPreferred: true })).toEqual({});
  expect(sprintOfferTo("sprint", { userId: "u", proxyPreferred: undefined })).toEqual({});
  expect(sprintOfferTo("pro", { userId: "u" })).toEqual({});
});
