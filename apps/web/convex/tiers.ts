import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";

/**
 * The tiers, cheapest first. "sprint" is the 30-day pass: a one-off Polar
 * order rather than a subscription, held as a grant and reverted by
 * expireGrants like any other. See grantPass below.
 */
export type Tier = "free" | "sprint" | "pro" | "max";

export const tierValidator = v.union(
  v.literal("free"),
  v.literal("sprint"),
  v.literal("pro"),
  v.literal("max")
);

/** Ordering for "don't downgrade someone who already has more" comparisons */
export const TIER_RANK: Record<Tier, number> = { free: 0, sprint: 1, pro: 2, max: 3 };

/** The tier a user is actually on right now: "free" once a grant has lapsed, else the stored tier. */
export function effectiveTier(
  record: { tier: Tier; grantUntil?: number } | null | undefined,
  now = Date.now(),
): Tier {
  if (!record) return "free";
  if (record.grantUntil && record.grantUntil <= now) return "free";
  return record.tier;
}

/** Get the current user's tier and cancellation status */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { tier: "free" as const, isCancelled: false, periodEnd: null, grantUntil: null, grantSource: null };
    }

    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();

    const now = Date.now();
    const grantLapsed = !!record?.grantUntil && record.grantUntil <= now;

    return {
      tier: effectiveTier(record, now),
      isCancelled: !!record?.cancelledAt,
      periodEnd: record?.periodEnd ?? null,
      grantUntil: grantLapsed ? null : (record?.grantUntil ?? null),
      grantSource: grantLapsed ? null : (record?.grantSource ?? null),
    };
  },
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Apply a paid one-off pass. Polar sends these as orders, not subscriptions,
 * so there is nothing to renew or cancel — the pass is a grant with an expiry
 * and the existing expireGrants cron reverts it.
 *
 * grantSource tells a bought pass apart from an admin trial, which the billing
 * UI words differently and which isPayingRecord treats differently.
 */
export const grantPass = internalMutation({
  args: { userId: v.string(), tier: tierValidator, days: v.number(), polarCustomerId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();

    // Buying a pass must never cost someone a better plan they already pay
    // for. Extend the window, keep the higher tier.
    const current = effectiveTier(existing, now);
    const tier = TIER_RANK[current] > TIER_RANK[args.tier] ? current : args.tier;

    // A second pass extends the first rather than restarting it, so buying
    // two in a month buys two months.
    const liveGrant = existing?.grantUntil && existing.grantUntil > now ? existing.grantUntil : now;
    const grantUntil = liveGrant + args.days * DAY_MS;

    const patch = {
      tier,
      grantUntil,
      grantSource: "pass" as const,
      cancelledAt: undefined,
      periodEnd: undefined,
      updatedAt: now,
      ...(args.polarCustomerId != null ? { polarCustomerId: args.polarCustomerId } : {}),
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("userTiers", { userId: args.userId, ...patch });
    }
  },
});

/** Internal mutation for webhook-triggered tier updates */
export const update = internalMutation({
  args: {
    userId: v.string(),
    tier: tierValidator,
    polarCustomerId: v.optional(v.string()),
    polarSubscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();

    if (existing) {
      // A revoke must not wipe a manual grant that outlives the subscription
      // (e.g. a late-delivered webhook for an old sub after an admin trial).
      const keepGrant = args.tier === "free" && !!existing.grantUntil && existing.grantUntil > Date.now();
      const patch: Record<string, unknown> = {
        tier: keepGrant ? existing.tier : args.tier,
        // Clear cancellation, and the manual grant when a real sub replaces it
        cancelledAt: undefined,
        periodEnd: undefined,
        grantUntil: keepGrant ? existing.grantUntil : undefined,
        grantSource: keepGrant ? existing.grantSource : undefined,
        updatedAt: Date.now(),
      };
      if (args.polarCustomerId != null) patch.polarCustomerId = args.polarCustomerId;
      if (args.polarSubscriptionId != null) patch.polarSubscriptionId = args.polarSubscriptionId;
      await ctx.db.patch(existing._id, patch);
    } else {
      const doc: Record<string, unknown> = {
        userId: args.userId,
        tier: args.tier,
        updatedAt: Date.now(),
      };
      if (args.polarCustomerId != null) doc.polarCustomerId = args.polarCustomerId;
      if (args.polarSubscriptionId != null) doc.polarSubscriptionId = args.polarSubscriptionId;
      await ctx.db.insert("userTiers", doc as any);
    }
  },
});

/** Internal mutation for marking a subscription as cancelled (still active until period end) */
export const markCancelled = internalMutation({
  args: {
    userId: v.string(),
    periodEnd: v.number(),
    polarSubscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();

    if (!existing) {
      console.warn("[tiers] markCancelled: no userTiers record for userId:", args.userId, "sub:", args.polarSubscriptionId);
      return;
    }

    const patch: Record<string, unknown> = {
      cancelledAt: Date.now(),
      periodEnd: args.periodEnd,
      updatedAt: Date.now(),
    };
    if (args.polarSubscriptionId != null) patch.polarSubscriptionId = args.polarSubscriptionId;
    await ctx.db.patch(existing._id, patch);
  },
});

const DAILY_SCAN_LIMITS: Record<Tier, number> = { free: 10, sprint: 40, pro: 100, max: 1000 };

/** Check whether the current user can perform a manual scan */
export const canScan = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { canScan: false, remaining: 0, limit: 0 };
    const userId = identity.subject;

    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    const tier = effectiveTier(record);
    const limit = DAILY_SCAN_LIMITS[tier];

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const used = record?.dailyScansDate === today ? (record?.dailyScans ?? 0) : 0;

    return { canScan: used < limit, remaining: Math.max(0, limit - used), limit };
  },
});

/** Atomically check budget and consume a scan. Returns { success, remaining, limit }. */
export const consumeScan = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = identity.subject;

    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    const tier = effectiveTier(record);
    const limit = DAILY_SCAN_LIMITS[tier];
    const today = new Date().toISOString().slice(0, 10);

    if (record) {
      const isToday = record.dailyScansDate === today;
      const used = isToday ? (record.dailyScans ?? 0) : 0;
      if (used >= limit) {
        return { success: false, remaining: 0, limit };
      }
      await ctx.db.patch(record._id, {
        dailyScans: used + 1,
        dailyScansDate: today,
      } as any);
      return { success: true, remaining: Math.max(0, limit - used - 1), limit };
    } else {
      // No tier record — create one (free tier, first scan)
      if (1 > limit) return { success: false, remaining: 0, limit }; // shouldn't happen, free limit is 10
      await ctx.db.insert("userTiers", {
        userId,
        tier: "free",
        dailyScans: 1,
        dailyScansDate: today,
        updatedAt: Date.now(),
      } as any);
      return { success: true, remaining: limit - 1, limit };
    }
  },
});
