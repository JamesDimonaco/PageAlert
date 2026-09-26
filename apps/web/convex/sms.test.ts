/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const NOW = 1_700_000_000_000;

function verification(userId: string, expiresAt: number) {
  return {
    userId,
    phone: `+4479111${userId.slice(-5)}`,
    code: "481920",
    expiresAt,
    attempts: 0,
    sentCount: 1,
    sentDate: "2026-09-26",
  };
}

/**
 * A verification row holds a raw phone number. It dies on a confirmed code, on
 * a later failed one, or on releaseVerification — but a code requested and
 * never entered has none of those happen to it, so without this sweep the
 * number sits there for good. The privacy page says a code you do not finish
 * is deleted after it expires, which is only true because of this.
 */
describe("expireVerifications", () => {
  it("deletes rows past their expiry and leaves live ones alone", async () => {
    const t = convexTest(schema, modules);

    const { stale, live } = await t.run(async (ctx) => ({
      stale: await ctx.db.insert("phoneVerifications", verification("user-stale", NOW - 60_000)),
      live: await ctx.db.insert("phoneVerifications", verification("user-live", NOW + 600_000)),
    }));

    await t.mutation(internal.sms.expireVerifications, { now: NOW });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(stale), "an expired verification survived the sweep").toBeNull();
      expect(await ctx.db.get(live), "a live verification was swept").not.toBeNull();
    });
  });

  it("sweeps a row whose expiry was zeroed by releaseVerification", async () => {
    // releaseVerification sets expiresAt to 0 rather than deleting, when the
    // user has codes left on the day. That row still holds the number.
    const t = convexTest(schema, modules);

    const released = await t.run((ctx) =>
      ctx.db.insert("phoneVerifications", { ...verification("user-released", 0), sentCount: 2 })
    );

    await t.mutation(internal.sms.expireVerifications, { now: NOW });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(released), "a released verification kept the number").toBeNull();
    });
  });
});
