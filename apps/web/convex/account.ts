import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";

/** Is this user currently banned? Shared by every mutation that gates on ban status. */
export async function isBanned(ctx: QueryCtx | MutationCtx, userId: string): Promise<boolean> {
  const row = await ctx.db
    .query("bannedUsers")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  return !!row;
}

/**
 * Deletes every row this app owns for a user: monitors and their scrape
 * results/notifications, notification settings, remaining notifications,
 * channel claims, and the tier record. Shared by the user's own
 * deleteAccount and the admin dashboard's forced delete, so both paths
 * agree on what "all data" means — a userTiers row surviving account
 * deletion was a known gap this closes for both callers.
 */
export async function deleteAllUserData(ctx: MutationCtx, userId: string): Promise<void> {
  const monitors = await ctx.db
    .query("monitors")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();

  for (const monitor of monitors) {
    const results = await ctx.db
      .query("scrapeResults")
      .withIndex("by_monitorId", (q) => q.eq("monitorId", monitor._id))
      .collect();
    for (const result of results) {
      await ctx.db.delete(result._id);
    }

    const notifs = await ctx.db
      .query("notifications")
      .withIndex("by_monitorId", (q) => q.eq("monitorId", monitor._id))
      .collect();
    for (const notif of notifs) {
      await ctx.db.delete(notif._id);
    }

    await ctx.db.delete(monitor._id);
  }

  const settings = await ctx.db
    .query("notificationSettings")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  for (const setting of settings) {
    await ctx.db.delete(setting._id);
  }

  const remainingNotifs = await ctx.db
    .query("notifications")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  for (const notif of remainingNotifs) {
    await ctx.db.delete(notif._id);
  }

  const claims = await ctx.db
    .query("channelClaims")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  for (const claim of claims) {
    await ctx.db.delete(claim._id);
  }

  const tier = await ctx.db
    .query("userTiers")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (tier) await ctx.db.delete(tier._id);
}

export const deleteAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    await deleteAllUserData(ctx, identity.subject);
  },
});

/** Self-service: is the signed-in user banned? Null while auth is resolving. */
export const myBanStatus = query({
  args: {},
  handler: async (ctx): Promise<{ banned: boolean; reason: string | null } | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const row = await ctx.db
      .query("bannedUsers")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();
    return { banned: !!row, reason: row?.reason ?? null };
  },
});


