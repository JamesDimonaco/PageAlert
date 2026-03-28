import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

const tierValidator = v.union(v.literal("free"), v.literal("pro"), v.literal("max"));

/** Get the current user's tier */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { tier: "free" as const };

    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();

    return { tier: (record?.tier ?? "free") as "free" | "pro" | "max" };
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
      await ctx.db.patch(existing._id, {
        tier: args.tier,
        polarCustomerId: args.polarCustomerId,
        polarSubscriptionId: args.polarSubscriptionId,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("userTiers", {
        userId: args.userId,
        tier: args.tier,
        polarCustomerId: args.polarCustomerId,
        polarSubscriptionId: args.polarSubscriptionId,
        updatedAt: Date.now(),
      });
    }
  },
});
