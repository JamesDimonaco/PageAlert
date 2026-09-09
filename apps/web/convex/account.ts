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
 * channel claims, the tier record, and the creation-rate-limit log.
 * Shared by the user's own deleteAccount and the admin dashboard's
 * forced delete, so both paths agree on what "all data" means — a
 * userTiers row surviving account deletion was a known gap this closes
 * for both callers.
 *
 * monitorCreations rows are kept across *monitor* deletion (see
 * monitors.ts) to stop a delete-and-remake bypassing the creation rate
 * limit, but a full account delete gets a fresh userId on re-signup
 * regardless, so retaining them here serves no anti-abuse purpose —
 * they're just orphaned personal data at that point.
 *
 * Deliberately does NOT touch bannedUsers: deleteAccount (self-service)
 * doesn't remove the caller's Better Auth session, so the same still-
 * logged-in identity would remain — dropping the ban row here would let
 * a banned user delete their way back to an unbanned session. Only
 * admin.deleteUser removes the ban record, because that path also
 * destroys the Better Auth session/account/user rows the ban was
 * blocking, so the userId can never come back to use it.
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

  const creations = await ctx.db
    .query("monitorCreations")
    .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
    .collect();
  for (const creation of creations) {
    await ctx.db.delete(creation._id);
  }
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


