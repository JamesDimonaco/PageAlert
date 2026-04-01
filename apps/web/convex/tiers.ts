import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

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
