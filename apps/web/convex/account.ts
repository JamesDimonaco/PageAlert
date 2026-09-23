import { v } from "convex/values";
import { MAX_LOG_ROW_BYTES } from "@prowl/shared";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";

/** Is this user currently banned? Shared by every mutation that gates on ban status. */
export async function isBanned(ctx: QueryCtx | MutationCtx, userId: string): Promise<boolean> {
  const row = await ctx.db
    .query("bannedUsers")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  return !!row;
}

/**
 * Deletes every row this app owns for a user.
 *
 * Monitors and their scrape results and notifications go inline, because a
 * result is only reachable through the monitor that owns it. Everything keyed
 * by userId goes through the batched sweep below instead, so no one
 * transaction has to read an account's whole history.
 *
 * Shared by the user's own deleteAccount and the admin dashboard's forced
 * delete, so both paths agree on what "all data" means.
 *
 * SWEPT_ON_DELETE and KEPT_ON_DELETE together name every table carrying a
 * userId, and account.test.ts fails if the schema grows one they don't cover.
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

  await sweepUserTables(ctx, userId);
}

/**
 * Every table keyed by userId, and the query that takes one batch of a user's
 * rows from it.
 *
 * Batched rather than collected because none of them is bounded per account:
 * the scrape log, the email sends, the thumbs and the rate-limit entries all
 * grow for as long as the account exists, and nothing prunes them. Reading
 * them all in one transaction would breach its read budget for exactly the
 * heaviest accounts, throw, and roll back — so the users with the most data
 * would be the only ones unable to delete it.
 *
 * `monitorCreations` survives *monitor* deletion (see monitors.ts) so a
 * delete-and-remake cannot bypass the creation rate limit, but a new signup
 * gets a new userId regardless, so after account deletion those rows are
 * orphaned personal data and nothing else. `appliedOrders` goes for the same
 * reason: Polar holds the receipt, and this table only exists to stop a
 * redelivered webhook granting one pass twice to a userId that no longer
 * exists.
 */
const SWEEPS: readonly {
  table: TableNames;
  batch: (ctx: MutationCtx, userId: string, take: number) => Promise<{ _id: Id<TableNames> }[]>;
}[] = [
  {
    table: "scrapeLogs",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("scrapeLogs")
        .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
        .take(take),
  },
  {
    table: "matchFeedback",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("matchFeedback")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(take),
  },
  {
    table: "emailSends",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("emailSends")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(take),
  },
  {
    table: "onboardingEmails",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("onboardingEmails")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(take),
  },
  {
    table: "notifications",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("notifications")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(take),
  },
  {
    table: "notificationSettings",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("notificationSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(take),
  },
  {
    table: "pushSubscriptions",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("pushSubscriptions")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(take),
  },
  {
    table: "channelClaims",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("channelClaims")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(take),
  },
  {
    table: "monitorCreations",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("monitorCreations")
        .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
        .take(take),
  },
  {
    table: "appliedOrders",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("appliedOrders")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(take),
  },
  {
    table: "reviews",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("reviews")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(take),
  },
  {
    table: "userTiers",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("userTiers")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(take),
  },
  {
    table: "userActivity",
    batch: (ctx, userId, take) =>
      ctx.db
        .query("userActivity")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(take),
  },
];

/**
 * Every table account deletion clears, the inline monitor sweep included.
 * Exported so a test can prove the schema holds no userId table it misses.
 */
export const SWEPT_ON_DELETE: readonly string[] = [
  "monitors",
  ...SWEEPS.map((sweep) => sweep.table),
];

/**
 * Tables that go on holding a userId after the account is gone.
 *
 * Only bannedUsers, and only on the self-service path: deleteAccount does not
 * remove the caller's Better Auth session, so the same still-logged-in
 * identity outlives the delete — dropping the ban row here would let a banned
 * user delete their way back to an unbanned session. admin.deleteUser does
 * remove it, because that path also destroys the session, account and user
 * rows the ban was blocking, so the userId can never come back to use it.
 */
export const KEPT_ON_DELETE: readonly string[] = ["bannedUsers"];

/**
 * Rows deleted per round.
 *
 * Derived rather than picked: a scrapeLogs row is the heaviest thing the
 * sweep can read and capLogFields caps it at MAX_LOG_ROW_BYTES, so this is
 * how many fit in half of a transaction's ~8MB read budget. The other half is
 * left for the monitor sweep the first round shares its transaction with.
 */
const SWEEP_BUDGET_BYTES = 4_000_000;
export const SWEEP_BATCH = Math.floor(SWEEP_BUDGET_BYTES / MAX_LOG_ROW_BYTES);

/**
 * Deletes up to one batch of a user's rows, taking the tables in order, and
 * queues another round if it filled the batch.
 *
 * Spending one allowance across the tables rather than a batch per table
 * means an ordinary account finishes in the first round with nothing
 * scheduled at all, while a heavy one still reads at most SWEEP_BATCH rows
 * however many tables it spans.
 *
 * Past the first round this is no longer atomic with the account deletion,
 * which is the right way round: the goal is erasure, so partial progress
 * toward it beats refusing to start.
 */
async function sweepUserTables(ctx: MutationCtx, userId: string): Promise<void> {
  let allowance = SWEEP_BATCH;

  for (const sweep of SWEEPS) {
    if (allowance === 0) break;
    const rows = await sweep.batch(ctx, userId, allowance);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    allowance -= rows.length;
  }

  if (allowance === 0) {
    await ctx.scheduler.runAfter(0, internal.account.sweepRemainingUserData, { userId });
  }
}

/** Continues sweepUserTables for an account holding more than one batch. */
export const sweepRemainingUserData = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    await sweepUserTables(ctx, userId);
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
