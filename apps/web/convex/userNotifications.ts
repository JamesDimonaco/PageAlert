import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";

/** Get recent notifications for the current user */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    return ctx.db
      .query("notifications")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(Math.min(args.limit ?? 20, 50));
  },
});

/** Get unread notification count */
export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return 0;

    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_userId_read", (q) =>
        q.eq("userId", identity.subject).eq("read", false)
      )
      .collect();

    return unread.length;
  },
});

/** Mark a single notification as read */
export const markRead = mutation({
  args: { id: v.id("notifications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const notif = await ctx.db.get(args.id);
    if (!notif || notif.userId !== identity.subject) return;

    await ctx.db.patch(args.id, { read: true });
  },
});

/** Mark all notifications as read */
export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_userId_read", (q) =>
        q.eq("userId", identity.subject).eq("read", false)
      )
      .collect();

    for (const notif of unread) {
      await ctx.db.patch(notif._id, { read: true });
    }
  },
});

/** Create a notification (called internally by scheduler) */
export const create = internalMutation({
  args: {
    userId: v.string(),
    monitorId: v.id("monitors"),
    channel: v.union(v.literal("email"), v.literal("telegram"), v.literal("discord")),
    title: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("notifications", {
      userId: args.userId,
      monitorId: args.monitorId,
      channel: args.channel,
      title: args.title,
      message: args.message,
      sentAt: Date.now(),
      read: false,
    });
  },
});
