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
// AI read every few minutes and never told its owner. A shop that answers
// "gone" twice in a row, at the end of the retry ladder, will not come back.
test("parks a monitor whose retry ladder ends on two page-not-founds in a row", async () => {
  const { t, id } = await setup({ retryCount: MAX_RETRIES - 1, lastError: GONE });
  const outcome = await t.mutation(internal.scheduler.recordCheckResult, { monitorId: id, ...fail(GONE) });
  expect(outcome).toMatchObject({ parked: true, parkReason: PARK_REASON_PAGE_GONE });
  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect(monitor?.status).toBe("error");
  expect(monitor?.nextCheckAt).toBeUndefined();
  expect(monitor?.lastError).toContain(PARK_REASON_PAGE_GONE);
});

// One 404 after a block could be a shop's glitch. It takes two.
test("does not park on a single page-not-found", async () => {
  const { t, id } = await setup({ retryCount: MAX_RETRIES - 1, lastError: BLOCKED });
  const outcome = await t.mutation(internal.scheduler.recordCheckResult, { monitorId: id, ...fail(GONE) });
  expect(outcome).toMatchObject({ parked: false });
  expect((await t.run((ctx) => ctx.db.get(id)))?.nextCheckAt).toBeGreaterThan(NOW);
});

// The early retries are 2 and 8 minutes apart. Parking there would stop a
// monitor inside one bad deploy at the shop.
test("does not park before the retry ladder ends", async () => {
  const { t, id } = await setup({ retryCount: MAX_RETRIES - 2, lastError: GONE });
  expect(await t.mutation(internal.scheduler.recordCheckResult, { monitorId: id, ...fail(GONE) })).toMatchObject({ parked: false });
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
