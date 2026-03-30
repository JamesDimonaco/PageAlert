import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const channelValidator = v.union(
  v.literal("email"),
  v.literal("telegram"),
  v.literal("discord")
);

type Tier = "free" | "pro" | "max";
const TIER_CHANNELS: Record<Tier, string[]> = {
  free: ["email"],
  pro: ["email", "telegram", "discord"],
  max: ["email", "telegram", "discord"],
};

async function getUserTier(ctx: { db: any }, userId: string): Promise<Tier> {
  const record = await ctx.db
    .query("userTiers")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .unique();
  return (record?.tier as Tier) ?? "free";
}

/** Get all notification settings for the current user */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return ctx.db
      .query("notificationSettings")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .collect();
  },
});

/** Save or update a notification channel setting */
export const upsert = mutation({
  args: {
    channel: channelValidator,
    enabled: v.boolean(),
    target: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = identity.subject;

    // Enforce tier-based channel access
    const tier = await getUserTier(ctx, userId);
    if (!TIER_CHANNELS[tier].includes(args.channel)) {
      throw new Error(`${args.channel} notifications require a Pro or Max plan`);
    }

    // Validate target based on channel
    if (args.channel === "telegram" && args.enabled) {
      if (!/^\d+$/.test(args.target.trim())) {
        throw new Error("Telegram Chat ID must be a number");
      }
    }
    if (args.channel === "discord" && args.enabled) {
      if (!args.target.trim().startsWith("https://discord.com/api/webhooks/")) {
        throw new Error("Invalid Discord webhook URL");
      }
    }

    const existing = await ctx.db
      .query("notificationSettings")
      .withIndex("by_userId_channel", (q) =>
        q.eq("userId", userId).eq("channel", args.channel)
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        enabled: args.enabled,
        target: args.target.trim(),
      });
    } else {
      await ctx.db.insert("notificationSettings", {
        userId,
        channel: args.channel,
        enabled: args.enabled,
        target: args.target.trim(),
      });
    }
  },
});

/** Remove a notification channel setting */
export const remove = mutation({
  args: { channel: channelValidator },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("notificationSettings")
      .withIndex("by_userId_channel", (q) =>
        q.eq("userId", identity.subject).eq("channel", args.channel)
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});
