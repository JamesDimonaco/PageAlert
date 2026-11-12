import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireLiveAccount } from "./account";
import { turnOnChannel, type Rollout } from "./monitorChannels";

/**
 * Device registrations for web push. Kept apart from convex/push.ts because
 * that file runs in Node for the VAPID signing, and Node actions can't hold
 * queries or mutations.
 */

/** Register this device, or refresh it if the endpoint is already known */
export const subscribe = mutation({
  args: {
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    await requireLiveAccount(ctx, identity.subject);

    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .unique();

    // The user's first device is them turning browser alerts on, so they go
    // on every monitor (see monitorChannels.ts). A second device changes
    // nothing: the monitors already have push.
    const hadDevice =
      (await ctx.db
        .query("pushSubscriptions")
        .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
        .first()) !== null;
    const rollout: Rollout = hadDevice
      ? { monitorIds: [], groupIds: [] }
      : await turnOnChannel(ctx, identity.subject, "push");

    // Browsers reissue the same endpoint to whoever is signed in, so an
    // endpoint that resurfaces under a different user has changed hands.
    if (existing) {
      await ctx.db.patch(existing._id, {
        userId: identity.subject,
        p256dh: args.p256dh,
        auth: args.auth,
        userAgent: args.userAgent,
      });
      return rollout;
    }

    await ctx.db.insert("pushSubscriptions", {
      userId: identity.subject,
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      userAgent: args.userAgent,
      createdAt: Date.now(),
    });
    return rollout;
  },
});

/** Drop this device's registration */
export const unsubscribe = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .unique();
    if (existing && existing.userId === identity.subject) {
      await ctx.db.delete(existing._id);
    }
  },
});

/** How many devices the current user has push enabled on */
export const deviceCount = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return 0;
    const rows = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .collect();
    return rows.length;
  },
});

export const listForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("pushSubscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect(),
});

/** Remove an endpoint the push service has told us is dead */
export const deleteByEndpoint = internalMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
