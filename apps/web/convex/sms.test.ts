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
  };
}

/**
 * A verification row holds a raw phone number. It dies on a confirmed code, on
 * a later failed one, or on releaseVerification — but a code requested and
 * never entered has none of those happen to it, so without this sweep the
 * number sits there for good. The privacy page says a code you do not finish
 * is deleted after it expires, which is only true because of this.
 */
/**
 * The cap /sms-policy promises carriers: "An account may request at most 3
 * codes per day." A counter living on the verification row cannot deliver
 * that, because every terminal path deletes the row — a confirmed code, an
 * expired one, five wrong guesses, and the hourly sweep. Each one hands the
 * account a fresh three.
 */
describe("claimVerification daily cap", () => {
  async function claim(t: ReturnType<typeof convexTest>) {
    return t.mutation(internal.sms.claimVerification, {
      userId: "user-capped",
      phone: "+447911123456",
    });
  }

  it("counts codes for the day even when the pending row is gone", async () => {
    const t = convexTest(schema, modules);

    for (let i = 0; i < 3; i++) await claim(t);
    await expect(claim(t)).rejects.toThrow(/3 codes today/);

    // What a confirmed code, an expired one, or the sweep all leave behind.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("phoneVerifications")
        .withIndex("by_userId", (q) => q.eq("userId", "user-capped"))
        .unique();
      if (row) await ctx.db.delete(row._id);
    });

    await expect(claim(t)).rejects.toThrow(/3 codes today/);
  });

  it("does not let one account's codes count against another's", async () => {
    const t = convexTest(schema, modules);

    for (let i = 0; i < 3; i++) await claim(t);
    await expect(
      t.mutation(internal.sms.claimVerification, { userId: "user-other", phone: "+447911999888" })
    ).resolves.toMatch(/^\d{6}$/);
  });
});

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

  it("sweeps a row left with a zero expiry", async () => {
    // Nothing writes expiresAt: 0 today — releaseVerification deletes the row
    // outright — but rows written before that change carry it, and a zero read
    // as "no expiry" rather than "long expired" would strand the number.
    const t = convexTest(schema, modules);

    const released = await t.run((ctx) =>
      ctx.db.insert("phoneVerifications", verification("user-released", 0))
    );

    await t.mutation(internal.sms.expireVerifications, { now: NOW });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(released), "a released verification kept the number").toBeNull();
    });
  });
});
