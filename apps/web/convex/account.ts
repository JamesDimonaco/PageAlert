import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";

/** Is this user currently banned? Shared by every mutation that gates on ban status. */
export async function isBanned(ctx: QueryCtx | MutationCtx, userId: string): Promise<boolean> {
  const row = await ctx.db
    .query("bannedUsers")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  return !!row;
}

/**
 * Deletes every row this app owns for a user. Shared by the user's own
 * deleteAccount and the admin dashboard's forced delete, so both paths
 * agree on what "all data" means. account.test.ts checks it against the
 * schema: a new table has to be handled here or listed as kept there.
 *
 * Kept on purpose:
 * - bannedUsers: a ban has to outlive the account it was placed on, or
 *   deleting the account would be the way round it. deleteAccount refuses
 *   banned users; admin.deleteUser drops the row itself.
 * - appliedOrders: opaque Polar order ids. Polar redelivers webhooks for
 *   up to a day, and this is what stops a redelivered order recreating a
 *   tier row for a user who no longer exists.
 * - adminEmails: the operator's record of what was sent and to whom.
 * - counters, anonymousScanCounter: aggregates, no personal data.
 *
 * monitorCreations rows are kept across *monitor* deletion (see
 * monitors.ts) to stop a delete-and-remake bypassing the creation rate
 * limit, but a full account delete gets a fresh userId on re-signup
 * regardless, so retaining them here serves no anti-abuse purpose.
 *
 * scrapeLogs can run to tens of thousands of rows for one user, more than
 * a transaction holds, so that table is purged in scheduled batches.
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

  const subscriptions = await ctx.db
    .query("pushSubscriptions")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  for (const subscription of subscriptions) {
    await ctx.db.delete(subscription._id);
  }

  const feedback = await ctx.db
    .query("matchFeedback")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  for (const row of feedback) {
    await ctx.db.delete(row._id);
  }

  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  for (const review of reviews) {
    await ctx.db.delete(review._id);
  }

  const sends = await ctx.db
    .query("emailSends")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  for (const send of sends) {
    await ctx.db.delete(send._id);
  }

  const onboarding = await ctx.db
    .query("onboardingEmails")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  for (const row of onboarding) {
    await ctx.db.delete(row._id);
  }

  await ctx.scheduler.runAfter(0, internal.logs.purgeForUser, { userId });
}

type UserIdRow = { field: "userId"; operator: "eq"; value: string };

/** Deletes every matching Better Auth row for a user, a page at a time until none remain. */
async function deleteAllRowsByUser(
  ctx: MutationCtx,
  input: { model: "session"; where: UserIdRow[] } | { model: "account"; where: UserIdRow[] },
): Promise<void> {
  for (let page = 0; page < 40; page++) {
    const result = await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input,
      paginationOpts: { numItems: 200, cursor: null },
    });
    if (result.count === 0 || result.isDone) break;
  }
}

/**
 * Removes the user's Better Auth session, OAuth account and user rows: the
 * email, name and sign-in identity. Without this, "delete my account" left
 * the login itself behind, and the privacy policy's "permanently removed"
 * was untrue for the most personal data we hold.
 */
export async function deleteAuthRows(ctx: MutationCtx, userId: string): Promise<void> {
  const idFilter: UserIdRow[] = [{ field: "userId", operator: "eq", value: userId }];
  await deleteAllRowsByUser(ctx, { model: "session", where: idFilter });
  await deleteAllRowsByUser(ctx, { model: "account", where: idFilter });
  await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
    input: { model: "user", where: [{ field: "_id", operator: "eq", value: userId }] },
  });
}

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
    // With the login rows gone, the same person signs up again as a fresh,
    // unbanned userId. Erasure for a banned user goes through the contact email.
    if (await isBanned(ctx, identity.subject)) {
      throw new Error("This account is suspended. Email us to have it deleted.");
    }
    await deleteAllUserData(ctx, identity.subject);
    await deleteAuthRows(ctx, identity.subject);
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


