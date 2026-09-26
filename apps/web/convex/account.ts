import { getDocumentSize, v, type Value } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
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
 * Does the account behind this userId still exist?
 *
 * A signed-in call carries a JWT, and Convex verifies it against the JWKS
 * endpoint rather than the session table — so a token minted before the
 * deletion keeps working for the rest of its 15 minutes, and every mutation
 * trusts `identity.subject` without asking whether that user still exists.
 *
 * Only the mutations that write a row keyed to the userId need to ask. A
 * monitor created in that window is unreachable forever, because its owner
 * has no account left to sign in with, and it goes on scanning and emailing;
 * a notification setting puts the deleted address straight back in the
 * database; an activity stamp makes the erasure audit cry wolf. Reads and
 * edits of the user's own rows need no guard: the rows are gone, so they
 * find nothing.
 *
 * Mutations behind a button call requireLiveAccount and throw. The ones the
 * dashboard fires on its own on every load check this directly and write
 * nothing, because the layout retries a claim that throws on every render
 * and a dead session would spend its last quarter hour filling the console.
 */
export async function isLiveAccount(ctx: MutationCtx, userId: string): Promise<boolean> {
  const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [{ field: "_id", operator: "eq", value: userId }],
  });
  return user !== null;
}

/** Refuses a caller whose account has been deleted. See isLiveAccount. */
export async function requireLiveAccount(ctx: MutationCtx, userId: string): Promise<void> {
  if (!(await isLiveAccount(ctx, userId))) throw new Error("This account no longer exists.");
}

type UserIdRow = { field: "userId"; operator: "eq"; value: string };

/** Deletes every matching row for a user, a page at a time until none remain. */
async function deleteAllAuthRows(
  ctx: MutationCtx,
  input: { model: "session"; where: UserIdRow[] } | { model: "account"; where: UserIdRow[] }
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
 * Removes the Better Auth identity behind a userId: every session, every
 * linked provider account, then the user row carrying the name and email.
 *
 * This does NOT cut off access straight away, and it is worth being exact
 * about why. Convex authenticates a call by verifying a JWT against the JWKS
 * endpoint (auth.config.ts), never by reading the session table, and the
 * convex plugin mints those tokens with a 15 minute life. Deleting the
 * sessions stops the cookie minting a *new* token; a token already in hand
 * goes on working until it expires, and every mutation trusts
 * `identity.subject` without checking the user still exists. So for up to 15
 * minutes after this runs, the deleted identity can still call the API.
 *
 * Shared by the admin's forced delete and the user's own, which is the point:
 * these were separate before, and only one of them did it.
 */
export async function deleteAuthIdentity(ctx: MutationCtx, userId: string): Promise<void> {
  const where: UserIdRow[] = [{ field: "userId", operator: "eq", value: userId }];
  await deleteAllAuthRows(ctx, { model: "session", where });
  await deleteAllAuthRows(ctx, { model: "account", where });
  await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
    input: { model: "user", where: [{ field: "_id", operator: "eq", value: userId }] },
  });
}

/**
 * Ten minutes is far longer than the sweep needs even for the heaviest
 * account, so anything still there when the audit runs means the chain
 * stopped early rather than that it is still going.
 */
const AUDIT_DELAY_MS = 10 * 60 * 1000;

/**
 * Deletes every row this app owns for a user, over as many rounds as it takes.
 *
 * Shared by the user's own deleteAccount and the admin dashboard's forced
 * delete, so both paths agree on what "all data" means.
 *
 * `email` is required rather than optional because emailSends is only
 * reachable by address for most of its rows, and a caller that forgot to
 * pass it would silently leave a user's alert history behind — the exact bug
 * this function keeps being fixed for. Pass undefined only when there is
 * genuinely no address on record.
 *
 * SWEPT_ON_DELETE and KEPT_ON_DELETE together name every table carrying a
 * userId, and account.test.ts fails if the schema grows one they don't cover.
 */
export async function deleteAllUserData(
  ctx: MutationCtx,
  userId: string,
  email: string | undefined
): Promise<void> {
  const target: Target = { userId, email };
  await sweep(ctx, target);
  await ctx.scheduler.runAfter(AUDIT_DELAY_MS, internal.account.auditErasure, target);
}

/**
 * What one round of the sweep may spend.
 *
 * Both are enforced as the round runs, not assumed of the data: the sweep
 * streams each table and stops the moment it has spent either, so no row size
 * and no row count anywhere in the schema can carry a round past what a
 * transaction will take. That matters most for scrapeResults, which is the
 * heaviest thing an account owns and which nothing caps or prunes — a busy
 * pro account accrues tens of thousands of them a year, and collecting them
 * all is how the delete used to fail for precisely the accounts that needed
 * it. Convex will accept a document up to ONE_CONVEX_DOCUMENT_BYTES, so a
 * round reads at most its byte budget plus the one row that crossed it.
 */
export const ONE_CONVEX_DOCUMENT_BYTES = 1024 * 1024;
export const SWEEP_BUDGET_BYTES = 4_000_000;
export const SWEEP_BUDGET_ROWS = 1_000;

type Allowance = { bytes: number; rows: number };

const spent = (left: Allowance): boolean => left.bytes <= 0 || left.rows <= 0;

/**
 * What a row weighs, by Convex's own reckoning — the same calculation behind
 * the document size and bandwidth limits the budget is defending.
 *
 * Not a JSON proxy. Serialising to measure gets two things wrong: a string's
 * length counts UTF-16 code units, so a CJK character reads as one where it
 * costs three bytes, and JSON.stringify *throws* on Int64. Both `schema` and
 * `matchConditions` are `v.any()`, which accepts Int64 and Bytes, so a row
 * holding either would have taken the whole deletion down with it — and the
 * owner cannot edit that row to get themselves unstuck.
 */
const byteSize = (row: Record<string, Value>): number => getDocumentSize(row);

/** A query the sweep can stream and the audit can peek at. */
type Rows = AsyncIterable<{ _id: Id<TableNames> }> & { first(): Promise<unknown> };

/**
 * Deletes rows from one query until the allowance runs out.
 *
 * Streaming rather than `.take(n)`: a count says nothing about what the rows
 * weigh, and the byte budget can only be honest if it is measured against
 * what was actually read.
 */
async function drain(ctx: MutationCtx, rows: Rows, left: Allowance): Promise<void> {
  for await (const row of rows) {
    await ctx.db.delete(row._id);
    left.bytes -= byteSize(row);
    left.rows -= 1;
    if (spent(left)) return;
  }
}

/** Who the sweep is erasing. The email reaches sends that carry no userId. */
type Target = { userId: string; email?: string };

const monitorsOf = (ctx: MutationCtx, userId: string) =>
  ctx.db.query("monitors").withIndex("by_userId", (q) => q.eq("userId", userId));

/**
 * Sends addressed to the account, whoever recorded them. Most send sites
 * record no userId, so this is how most of a user's history is reached; the
 * index is exact-match, and recordSend lowercases on the way in.
 */
const sendsTo = (ctx: MutationCtx, email: string) =>
  ctx.db.query("emailSends").withIndex("by_to", (q) => q.eq("to", email.toLowerCase()));

/**
 * A monitor and everything hanging off it.
 *
 * Children go first and the monitor last, so a round that runs out midway
 * leaves the monitor in place and the next round finds it again with fewer
 * children. Anonymous monitors are not swept here: signup claims any carrying
 * the account's address and clears anonymousEmail (see anonymous.ts), so one
 * still holding an address belongs to a scan that never became this account,
 * and the daily cron expires it.
 */
async function sweepMonitors(ctx: MutationCtx, userId: string, left: Allowance): Promise<void> {
  for await (const monitor of monitorsOf(ctx, userId)) {
    // Charged on read, not on delete: a monitor carries `schema: v.any()` and
    // three arrays with no size limit, and the round has already paid to read
    // it even if it runs out before deleting it. Checked straight afterwards
    // so the monitor that crosses the budget is the last thing the round
    // reads, rather than the round going on to read a child as well.
    left.bytes -= byteSize(monitor);
    if (spent(left)) return;

    await drain(
      ctx,
      ctx.db.query("scrapeResults").withIndex("by_monitorId", (q) => q.eq("monitorId", monitor._id)),
      left
    );
    if (spent(left)) return;

    // By monitor, not by userId: a scan that ran anonymously wrote its logs
    // under an `anon_` id, and claiming the monitor at signup re-keys the
    // monitor alone (anonymous.ts). Those logs hold the URL, the prompt and
    // the raw AI response of every check, and the sweep by userId below
    // cannot see them.
    await drain(
      ctx,
      ctx.db.query("scrapeLogs").withIndex("by_monitorId", (q) => q.eq("monitorId", monitor._id)),
      left
    );
    if (spent(left)) return;

    await drain(
      ctx,
      ctx.db.query("notifications").withIndex("by_monitorId", (q) => q.eq("monitorId", monitor._id)),
      left
    );
    if (spent(left)) return;

    await ctx.db.delete(monitor._id);
    left.rows -= 1;
    if (spent(left)) return;
  }
}

/**
 * Every table keyed by userId that deletion clears, and the query that finds
 * a user's rows in it.
 *
 * `monitorCreations` survives *monitor* deletion (see monitors.ts) so a
 * delete-and-remake cannot bypass the creation rate limit, but a new signup
 * gets a new userId regardless, so after account deletion those rows are
 * orphaned personal data and nothing else. `reviews` goes too, which takes
 * the quote off the public homepage along with the name it was signed with —
 * erasure has to mean that, but it is a visible change and not only a
 * database one.
 */
const SWEEPS: readonly {
  table: TableNames;
  rows: (ctx: MutationCtx, userId: string) => Rows;
}[] = [
  {
    table: "scrapeLogs",
    rows: (ctx, userId) =>
      ctx.db.query("scrapeLogs").withIndex("by_userId_createdAt", (q) => q.eq("userId", userId)),
  },
  {
    table: "matchFeedback",
    rows: (ctx, userId) =>
      ctx.db.query("matchFeedback").withIndex("by_userId", (q) => q.eq("userId", userId)),
  },
  {
    table: "emailSends",
    rows: (ctx, userId) =>
      ctx.db.query("emailSends").withIndex("by_userId", (q) => q.eq("userId", userId)),
  },
  {
    table: "onboardingEmails",
    rows: (ctx, userId) =>
      ctx.db.query("onboardingEmails").withIndex("by_userId", (q) => q.eq("userId", userId)),
  },
  {
    table: "notifications",
    rows: (ctx, userId) =>
      ctx.db.query("notifications").withIndex("by_userId", (q) => q.eq("userId", userId)),
  },
  {
    table: "notificationSettings",
    rows: (ctx, userId) =>
      ctx.db.query("notificationSettings").withIndex("by_userId", (q) => q.eq("userId", userId)),
  },
  {
    table: "pushSubscriptions",
    rows: (ctx, userId) =>
      ctx.db.query("pushSubscriptions").withIndex("by_userId", (q) => q.eq("userId", userId)),
  },
  {
    table: "channelClaims",
    rows: (ctx, userId) =>
      ctx.db.query("channelClaims").withIndex("by_userId", (q) => q.eq("userId", userId)),
  },
  {
    table: "monitorCreations",
    rows: (ctx, userId) =>
      ctx.db.query("monitorCreations").withIndex("by_userId_createdAt", (q) => q.eq("userId", userId)),
  },
  {
    table: "reviews",
    rows: (ctx, userId) =>
      ctx.db.query("reviews").withIndex("by_userId", (q) => q.eq("userId", userId)),
  },
  {
    table: "userTiers",
    rows: (ctx, userId) =>
      ctx.db.query("userTiers").withIndex("by_userId", (q) => q.eq("userId", userId)),
  },
  {
    table: "userActivity",
    rows: (ctx, userId) =>
      ctx.db.query("userActivity").withIndex("by_userId", (q) => q.eq("userId", userId)),
  },
  {
    // A row here holds a raw E.164 number. It normally dies when the code is
    // confirmed or abandoned, but a code requested and never entered sits
    // there until sms.expireVerifications sweeps it — and account deletion
    // must not wait on that.
    table: "phoneVerifications",
    rows: (ctx, userId) =>
      ctx.db.query("phoneVerifications").withIndex("by_userId", (q) => q.eq("userId", userId)),
  },
  {
    table: "apiKeys",
    rows: (ctx, userId) =>
      ctx.db.query("apiKeys").withIndex("by_userId", (q) => q.eq("userId", userId)),
  },
];

/**
 * Every table account deletion clears, the monitor sweep included. Exported
 * so a test can prove the schema holds no userId table it misses.
 */
export const SWEPT_ON_DELETE: readonly string[] = [
  "monitors",
  ...SWEEPS.map((sweep) => sweep.table),
];

/**
 * Tables that go on holding a userId after the account is gone.
 *
 * - bannedUsers: every ban is enforced by userId (see isBanned's callers), so
 *   the ban row and the identity it names have to survive together or not at
 *   all. deleteAccount refuses a banned user outright; admin.deleteUser drops
 *   the row itself, with the identity.
 * - appliedOrders: opaque Polar order ids. Polar redelivers webhooks for up
 *   to a day, and this is what stops a redelivered order recreating a tier
 *   row for a user who no longer exists.
 */
export const KEPT_ON_DELETE: readonly string[] = ["bannedUsers", "appliedOrders"];

/**
 * Deletes up to one allowance of this user's rows and queues another round if
 * it spent the lot.
 *
 * Spending one allowance across the tables in order, rather than a batch per
 * table, means an ordinary account finishes inside the first transaction with
 * nothing scheduled at all, while a heavy one still reads no more than the
 * allowance however many tables it spans.
 *
 * Past the first round this is no longer atomic with the account deletion,
 * which is the right way round: the goal is erasure, so partial progress
 * toward it beats refusing to start.
 */
async function sweep(ctx: MutationCtx, target: Target): Promise<void> {
  const left: Allowance = { bytes: SWEEP_BUDGET_BYTES, rows: SWEEP_BUDGET_ROWS };

  await sweepMonitors(ctx, target.userId, left);

  for (const table of SWEEPS) {
    if (spent(left)) break;
    await drain(ctx, table.rows(ctx, target.userId), left);
  }

  if (!spent(left) && target.email) {
    await drain(ctx, sendsTo(ctx, target.email), left);
  }

  if (spent(left)) {
    await ctx.scheduler.runAfter(0, internal.account.sweepRemainingUserData, target);
  }
}

/** Continues the sweep for an account holding more than one round's worth. */
export const sweepRemainingUserData = internalMutation({
  args: { userId: v.string(), email: v.optional(v.string()) },
  handler: async (ctx, target) => {
    await sweep(ctx, target);
  },
});

/**
 * Checks the sweep actually finished, and shouts if it did not.
 *
 * Past the first round the sweep is a chain of scheduled mutations, and the
 * chain only continues from inside a run that succeeded: one throw ends it
 * silently with half a user's data still on disk, and the privacy page says
 * that data is gone within minutes. Nothing else would ever notice.
 * Scheduled by deleteAllUserData for well after the chain should be done.
 */
export const auditErasure = internalMutation({
  args: { userId: v.string(), email: v.optional(v.string()) },
  handler: async (ctx, { userId, email }) => {
    const peeks: Rows[] = [monitorsOf(ctx, userId), ...SWEEPS.map((table) => table.rows(ctx, userId))];
    if (email) peeks.push(sendsTo(ctx, email));

    for (const rows of peeks) {
      if ((await rows.first()) === null) continue;
      await ctx.scheduler.runAfter(0, internal.admin.notify, {
        text: `⚠️ Data survived account deletion for ${email ?? userId} (${userId}). The sweep stopped early — delete the rest by hand.`,
      });
      return;
    }
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
      // Fires on every navigation, so a dead session gets silence, not an error.
      if (!(await isLiveAccount(ctx, identity.subject))) return;
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

    await deleteAllUserData(ctx, identity.subject, identity.email);

    // The dialog says "permanently delete your account", so the identity goes
    // too — otherwise the name, email and linked provider account outlive the
    // data and the same userId re-attaches at the next sign-in.
    await deleteAuthIdentity(ctx, identity.subject);

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
