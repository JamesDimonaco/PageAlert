/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";
import type { Doc } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const NOW = Date.now();

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

async function insert(t: ReturnType<typeof setup>, name: string, extra: Partial<Doc<"monitors">> = {}) {
  return t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1", name, url: `https://shop.test/${name}`, prompt: "in stock", status: "active", checkInterval: "1h",
      matchCount: 1, lastAiExtractAt: NOW, nextCheckAt: NOW + 3_600_000, createdAt: NOW, updatedAt: NOW, ...extra,
    })
  );
}

// The backfill touches every live monitor on prod. Run by mistake, it must change nothing.
test("the backfill is a dry run unless told otherwise", async () => {
  const t = setup();
  const id = await insert(t, "ram");
  expect(await t.mutation(internal.backfill.markReReadDue, {})).toEqual({ dryRun: true, marked: 1 });
  expect((await t.run((ctx) => ctx.db.get(id)))?.lastAiExtractAt).toBe(NOW);
});

// Paused monitors cost nothing until resumed, and re-read then anyway.
test("the backfill marks live monitors due and leaves paused ones and their schedules alone", async () => {
  const t = setup();
  const active = await insert(t, "active");
  const errored = await insert(t, "errored", { status: "error" });
  const paused = await insert(t, "paused", { status: "paused" });
  const scanning = await insert(t, "scanning", { status: "scanning" });

  expect(await t.mutation(internal.backfill.markReReadDue, { dryRun: false })).toEqual({ dryRun: false, marked: 2 });
  const after = await t.run((ctx) => Promise.all([active, errored, paused, scanning].map((id) => ctx.db.get(id))));
  expect(after.map((m) => m?.lastAiExtractAt)).toEqual([0, 0, NOW, NOW]);
  // Spread across each monitor's own schedule, not all at once.
  expect(after.map((m) => m?.nextCheckAt)).toEqual([NOW + 3_600_000, NOW + 3_600_000, NOW + 3_600_000, NOW + 3_600_000]);
});

// The gate: re-read James's 7 monitors now, before anyone else's.
test("the backfill can be limited to some monitors and checked now", async () => {
  const t = setup();
  const gated = await insert(t, "gated");
  const other = await insert(t, "other");
  expect(await t.mutation(internal.backfill.markReReadDue, { dryRun: false, monitorIds: [gated], checkNow: true })).toEqual({
    dryRun: false,
    marked: 1,
  });
  const [g, o] = await t.run((ctx) => Promise.all([ctx.db.get(gated), ctx.db.get(other)]));
  expect([g?.lastAiExtractAt, g?.nextCheckAt]).toEqual([0, expect.any(Number)]);
  expect(g!.nextCheckAt!).toBeLessThanOrEqual(Date.now());
  expect(o?.lastAiExtractAt).toBe(NOW);
});

test("the snapshot lists each live monitor's matched keys, for comparing after", async () => {
  const t = setup();
  const id = await insert(t, "ram", { matchedKeys: ["shop.test/kingston"], candidateKeys: ["shop.test/a"] });
  await insert(t, "paused", { status: "paused", matchedKeys: ["x"] });
  expect(await t.query(internal.backfill.snapshotMatchKeys, {})).toEqual([
    { monitorId: id, name: "ram", matchedKeys: ["shop.test/kingston"], candidateKeys: ["shop.test/a"] },
  ]);
});

// Story 17: the re-read must not re-announce what the user already had, and
// a sold-out item that drops out must drop out silently.
test("a monitor marked due re-reads on its next check without re-announcing old matches", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const kept = { title: "Noctua NH-L12S", url: "https://shop.test/noctua", price: 109, inStock: true };
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/api/quick-check")) return Response.json({ accessible: true, contentHash: "page-2", candidates: [], totalEntries: 2 });
    if (url.endsWith("/api/extract")) {
      return Response.json({
        schema: { items: [kept, { title: "Kingston", url: "https://shop.test/kingston", price: 199, inStock: false }], matchConditions: { inStockOnly: true } },
        matches: [kept],
        totalItems: 2,
        contentHash: "page-2",
      });
    }
    return new Response("not mocked", { status: 500 });
  });
  const t = setup();
  const id = await insert(t, "cooler", {
    matchedKeys: ["shop.test/noctua", "shop.test/kingston"],
    schema: { items: [], matchConditions: {} },
    contentFingerprint: "page-1",
    checkCount: 5,
    nextCheckAt: 0,
  });
  await t.mutation(internal.backfill.markReReadDue, { dryRun: false, monitorIds: [id] });
  await t.action(internal.scheduler.runScheduledChecks, {});

  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect(monitor?.lastAiExtractAt).toBeGreaterThan(0);
  expect(monitor?.matchedKeys).toEqual(["shop.test/noctua"]);
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  expect(jobs.filter((j) => j.name.includes("sendMatchAlert") || j.name.includes("notify"))).toEqual([]);
});
