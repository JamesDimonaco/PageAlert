/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import betterAuthSchema from "./betterAuth/schema";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

// 08:00 UTC on 6 Oct, when the cron runs: "yesterday" is 5 Oct.
const PULSE_AT = Date.UTC(2026, 9, 6, 8, 0);

beforeEach(() => vi.useFakeTimers({ now: PULSE_AT }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

describe("daily pulse: SMS", () => {
  it("reports yesterday's texts, the month's spend against the budget, and who has texts on", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      for (const [name, value] of [
        ["sms:sent:2026-10-05", 12],
        ["sms:failed:2026-10-05", 2],
        ["sms:sent:2026-10-06", 99], // today so far, not yesterday
        ["sms:sends:2026-10", 140],
      ] as const) {
        await ctx.db.insert("counters", { name, value });
      }
      await ctx.db.insert("notificationSettings", { userId: "a", channel: "sms", enabled: true, target: "+447911000001" });
      await ctx.db.insert("notificationSettings", { userId: "b", channel: "sms", enabled: true, target: "+447911000002" });
      await ctx.db.insert("notificationSettings", { userId: "c", channel: "sms", enabled: false, target: "+447911000003" });
      await ctx.db.insert("notificationSettings", { userId: "a", channel: "email", enabled: true, target: "a@example.test" });
    });

    const s = await t.query(internal.pulse.snapshot, {});
    expect(s.sms).toEqual({ sent: 12, failed: 2, monthUsed: 140, budget: 2000, users: 2 });
  });

  it("reads zero on a day with no texts", async () => {
    const t = setup();
    const s = await t.query(internal.pulse.snapshot, {});
    expect(s.sms).toEqual({ sent: 0, failed: 0, monthUsed: 0, budget: 2000, users: 0 });
  });
});

describe("daily pulse: SMS month on the 1st", () => {
  it("reports the month that just ended, not the first eight hours of the new one", async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 1, 8, 0));
    const t = setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("counters", { name: "sms:sends:2026-10", value: 1900 });
      await ctx.db.insert("counters", { name: "sms:sends:2026-11", value: 3 });
    });
    const s = await t.query(internal.pulse.snapshot, {});
    expect(s.sms.monthUsed).toBe(1900);
  });
});
