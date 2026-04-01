import { mutation } from "./_generated/server";

export const deleteAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = identity.subject;

    // Delete all monitors and their associated data
    const monitors = await ctx.db
      .query("monitors")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    for (const monitor of monitors) {
      // Delete scrape results for this monitor
      const results = await ctx.db
        .query("scrapeResults")
        .withIndex("by_monitorId", (q) => q.eq("monitorId", monitor._id))
        .collect();
      for (const result of results) {
        await ctx.db.delete(result._id);
      }

      // Delete notifications for this monitor
      const notifs = await ctx.db
        .query("notifications")
        .withIndex("by_monitorId", (q) => q.eq("monitorId", monitor._id))
        .collect();
      for (const notif of notifs) {
        await ctx.db.delete(notif._id);
      }

      await ctx.db.delete(monitor._id);
    }

    // Delete notification settings
    const settings = await ctx.db
      .query("notificationSettings")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const setting of settings) {
      await ctx.db.delete(setting._id);
    }

    // Delete any remaining notifications not tied to monitors
    const remainingNotifs = await ctx.db
      .query("notifications")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const notif of remainingNotifs) {
      await ctx.db.delete(notif._id);
    }

    // Delete channel claims (anti-abuse)
    const claims = await ctx.db
      .query("channelClaims")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const claim of claims) {
      await ctx.db.delete(claim._id);
    }
  },
});
