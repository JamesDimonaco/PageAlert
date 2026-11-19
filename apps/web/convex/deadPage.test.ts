/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";
import type { Doc } from "./_generated/dataModel";
import { MAX_RETRIES, PARK_REASON_PAGE_GONE } from "./shared";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const NOW = Date.now();
const GONE = "Page not found (HTTP 404). The shop may have removed or moved it.";
const BLOCKED = "Site is blocking automated access: HTTP 403. Try a different URL or check if the site requires login.";

async function setup(extra: Partial<Doc<"monitors">> = {}) {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run(async (ctx) => {
    // Paid, so the third attempt would be a forced full read.
    await ctx.db.insert("userTiers", { userId: "user_1", tier: "pro", updatedAt: NOW });
    return ctx.db.insert("monitors", {
      userId: "user_1", name: "GPU", url: "https://shop.test/gpu", prompt: "in stock", status: "active", checkInterval: "24h",
      matchCount: 0, lastAiExtractAt: NOW, nextCheckAt: 0, checkCount: 5, createdAt: NOW, updatedAt: NOW,
      schema: { items: [], matchConditions: {} }, ...extra,
    });
  });
  return { t, id };
}

const fail = (error: string) => ({ hasNewMatches: false, matchCount: 0, totalItems: 0, matches: [], error });

// Prod, 15/11/2026: a removed Warehouse listing cost a Scrapfly call and an
// AI read every few minutes and never told its owner. Still gone on the 6h
// recovery check, after the retry ladder ended on it, it will not come back.
test("parks a monitor still gone on its recovery check", async () => {
  const { t, id } = await setup({ status: "error", retryCount: MAX_RETRIES, lastError: GONE });
  const outcome = await t.mutation(internal.scheduler.recordCheckResult, { monitorId: id, ...fail(GONE) });
  expect(outcome).toMatchObject({ parked: true, parkReason: PARK_REASON_PAGE_GONE });
  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect(monitor?.status).toBe("error");
  expect(monitor?.nextCheckAt).toBeUndefined();
  expect(monitor?.lastError).toContain(PARK_REASON_PAGE_GONE);
});

// One 404 after a block could be a shop's glitch. It takes two.
test("does not park on a single page-not-found", async () => {
  const { t, id } = await setup({ status: "error", retryCount: MAX_RETRIES, lastError: BLOCKED });
  const outcome = await t.mutation(internal.scheduler.recordCheckResult, { monitorId: id, ...fail(GONE) });
  expect(outcome).toMatchObject({ parked: false });
  expect((await t.run((ctx) => ctx.db.get(id)))?.nextCheckAt).toBeGreaterThan(NOW);
});

// The retry ladder is 10 minutes end to end. Parking on it would stop a
// monitor for good inside one bad deploy at the shop.
test("does not park on the retry ladder, however many 404s it gets", async () => {
  const { t, id } = await setup({ retryCount: MAX_RETRIES - 1, lastError: GONE });
  expect(await t.mutation(internal.scheduler.recordCheckResult, { monitorId: id, ...fail(GONE) })).toMatchObject({ parked: false });
  expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("error");
});

// The forced full read skips the block check, so on a shop that blocks us it
// read the 403 page, called it a success and reset the ladder. The Warehouse
// only shows its 404 through the proxy, so the retry has to use it too.
test("retries a page-not-found with a quick check through the proxy, not a forced full read", async () => {
  const { t } = await setup({ retryCount: 2, lastError: GONE });
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  vi.stubEnv("SCRAPFLY_API_KEY", "key");
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({ error: "check_failed", message: GONE }, { status: 404 });
  });
  await t.action(internal.scheduler.runScheduledChecks, {});
  expect(calls.map((c) => c.path)).toEqual(["/api/quick-check"]);
  expect(calls[0]!.body.useProxy).toBe(true);
});

// Prod, 19/11/2026: the Warehouse page of a GPU product died and an agent
// found out only by reading the product. The alert for a product's last
// working page says nothing is watching it now.
async function productListingFails(otherStatus: Doc<"monitors">["status"]) {
  const { t, id } = await setup({ retryCount: MAX_RETRIES - 1, lastError: GONE });
  await t.run(async (ctx) => {
    const groupId = await ctx.db.insert("monitorGroups", {
      userId: "user_1", name: "Reaper", region: "NZ", alertOn: { backInStock: true }, checkInterval: "24h", listings: [], createdAt: NOW, updatedAt: NOW,
    });
    await ctx.db.patch(id, { groupId });
    await ctx.db.insert("monitors", {
      userId: "user_1", name: "Reaper", url: "https://other.test/gpu", prompt: "in stock", status: otherStatus, checkInterval: "24h",
      matchCount: 0, createdAt: NOW, updatedAt: NOW, groupId,
    });
  });
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  vi.stubGlobal("fetch", async () => Response.json({ error: "check_failed", message: GONE }, { status: 404 }));
  await t.action(internal.scheduler.runScheduledChecks, {});
  const [notification] = await t.run((ctx) => ctx.db.query("notifications").collect());
  return notification!.message;
}

test("a product's last working page to fail says none of its pages is working", async () => {
  expect(await productListingFails("error")).toMatch(/None of Reaper's shop pages is working now/);
});

test("a product page failing while another works says nothing more", async () => {
  expect(await productListingFails("active")).not.toMatch(/None of/);
});
