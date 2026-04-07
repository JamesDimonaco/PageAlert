import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";

const tierValidator = v.union(v.literal("free"), v.literal("pro"), v.literal("max"));

/** Get the current user's tier and cancellation status */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { tier: "free" as const, isCancelled: false, periodEnd: null };

    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();

    return {
      tier: (record?.tier ?? "free") as "free" | "pro" | "max",
      isCancelled: !!record?.cancelledAt,
      periodEnd: record?.periodEnd ?? null,
    };
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
      const patch: Record<string, unknown> = {
        tier: args.tier,
        // Clear cancellation — this is called on new sub or revoke, both are definitive
        cancelledAt: undefined,
        periodEnd: undefined,
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

const DAILY_SCAN_LIMITS: Record<"free" | "pro" | "max", number> = { free: 10, pro: 100, max: 1000 };

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

    const tier = (record?.tier ?? "free") as "free" | "pro" | "max";
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

    const tier = (record?.tier ?? "free") as "free" | "pro" | "max";
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
