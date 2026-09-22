import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";

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
 * channel claims, the tier record, the creation-rate-limit log, the
 * last-seen record, and the scrape log.
 * Shared by the user's own deleteAccount and the admin dashboard's
 * forced delete, so both paths agree on what "all data" means — a
 * userTiers row surviving account deletion was a known gap this closes
 * for both callers.
 *
 * Two tables still hold an email address after this runs: emailSends and
 * onboardingEmails. Both are small (one and four rows for the worst account)
 * and both are deliberately left for a separate decision, not overlooked.
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

  const activity = await ctx.db
    .query("userActivity")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (activity) await ctx.db.delete(activity._id);

  await deleteScrapeLogs(ctx, userId);
}

/**
 * Scrape logs removed per mutation.
 *
 * 100 because a row carries rawResponse: the heaviest in prod is 23KB, so a
 * batch costs roughly 2.4MB of a transaction's ~8MB read budget even at that
 * size, alongside everything else the sweep reads. Taking them all at once
 * looked fine on today's numbers and was the wrong bet — nothing prunes this
 * table, deliberately, so the accounts holding the most would be exactly the
 * ones whose deletion blew the budget, threw, and rolled back. A user who
 * cannot delete their account is worse than a delete that takes ten rounds.
 */
const LOG_DELETE_BATCH = 100;

/**
 * Takes one batch of a user's scrape logs, and queues another if more remain.
 *
 * The log is the last and largest of it: every URL they watched, every prompt
 * they wrote, and the raw AI response for each check. It survived account
 * deletion until now because the per-monitor sweep does not take it — a log
 * outlives its monitor on purpose, so the logs page can still show checks for
 * one you have since deleted (1,372 of prod's 7,420 rows point at a monitor
 * that is gone). That leaves the account as the only thing that removes them.
 *
 * Past the first batch this is no longer atomic with the account deletion,
 * which is the right way round: the goal is erasure, so partial progress
 * toward it is acceptable where refusing to start is not.
 */
async function deleteScrapeLogs(ctx: MutationCtx, userId: string): Promise<void> {
  const batch = await ctx.db
    .query("scrapeLogs")
    .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
    .take(LOG_DELETE_BATCH);

  for (const log of batch) {
    await ctx.db.delete(log._id);
  }

  if (batch.length === LOG_DELETE_BATCH) {
    await ctx.scheduler.runAfter(0, internal.account.deleteRemainingScrapeLogs, { userId });
  }
}

/** Continues deleteScrapeLogs for an account holding more than one batch. */
export const deleteRemainingScrapeLogs = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    await deleteScrapeLogs(ctx, userId);
  },
});

/**
 * Record that this user is in the app right now. Called from the dashboard
 * layout on every load; the inactivity reaper reads it to decide whether
 * anybody is still there. See the userActivity comment in schema.ts for why
 * the Better Auth session table cannot answer that on its own.
 *
 * Throttled to an hour so a user clicking around the dashboard writes once,
 * not once a page: the reaper works in days, so an hour of staleness costs
 * nothing and a write per navigation would be pure noise.
 */
const TOUCH_THROTTLE_MS = 60 * 60 * 1000;

export const touchLastSeen = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;
    const now = Date.now();
    const row = await ctx.db
      .query("userActivity")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();
    if (!row) {
      await ctx.db.insert("userActivity", { userId: identity.subject, lastSeenAt: now });
      return;
    }
    if (now - row.lastSeenAt < TOUCH_THROTTLE_MS) return;
    await ctx.db.patch(row._id, { lastSeenAt: now });
  },
});

export const deleteAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    await deleteAllUserData(ctx, identity.subject);
    // The churn no webhook reports: someone leaving of their own accord.
    // admin.deleteUser has its own alert naming the admin who did it.
    await ctx.scheduler.runAfter(0, internal.admin.notify, {
      text: `📉 Account deleted by the user: ${identity.email ?? identity.subject}`,
    });
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


