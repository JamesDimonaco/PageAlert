import { v } from "convex/values";
import { mutation, query, internalMutation, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  HISTORY_WINDOW_DAYS,
  MAX_LOG_ROW_BYTES,
  capLogFields,
  historyCutoff,
  isWithinHistoryWindow,
} from "@prowl/shared";
import { effectiveTier } from "./tiers";
import type { Doc } from "./_generated/dataModel";

/** Shared validator for scrape log fields */
const scrapeLogArgs = {
  monitorId: v.optional(v.id("monitors")),
  monitorName: v.optional(v.string()),
  url: v.string(),
  prompt: v.string(),
  status: v.union(v.literal("success"), v.literal("error"), v.literal("timeout")),
  durationMs: v.number(),
  error: v.optional(v.string()),
  rawResponse: v.optional(v.string()),
  itemCount: v.optional(v.number()),
  matchCount: v.optional(v.number()),
  aiConfidence: v.optional(v.number()),
  aiUnderstanding: v.optional(v.string()),
  aiMatchSignal: v.optional(v.string()),
  aiNoMatchSignal: v.optional(v.string()),
  aiNotices: v.optional(v.array(v.string())),
  matchConditions: v.optional(v.any()),
  retryAttempt: v.optional(v.number()),
  blocked: v.optional(v.boolean()),
  blockReason: v.optional(v.string()),
  strategy: v.optional(v.string()),
};

export const create = mutation({
  args: scrapeLogArgs,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    return ctx.db.insert("scrapeLogs", {
      ...capLogFields(args),
      userId: identity.subject,
      createdAt: Date.now(),
    });
  },
});

/** Internal: create a scrape log without auth (for scheduler) */
export const createInternal = internalMutation({
  args: {
    userId: v.string(),
    ...scrapeLogArgs,
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("scrapeLogs", {
      ...capLogFields(args),
      createdAt: Date.now(),
    });
  },
});

/**
 * How far back this user may read, decided here rather than in the browser.
 *
 * useTier merges the Convex row with a live answer from Polar, so the client
 * can believe in a higher tier than the database holds. Letting it pick the
 * window would mean a page that shows 60 days of empty space; the server
 * reports the window it actually applied and the page renders that.
 */
async function windowFor(ctx: QueryCtx, userId: string, now: number) {
  const record = await ctx.db
    .query("userTiers")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  const tier = effectiveTier(record, now);
  return { tier, windowDays: HISTORY_WINDOW_DAYS[tier], cutoff: historyCutoff(tier, now) };
}

/**
 * Most rows one read of the list may take.
 *
 * Convex has no column projection: summarise() below trims what crosses the
 * wire, but the rows come off the database whole, rawResponse and all. So
 * this is the read budget divided by what a row can cost — not a number
 * picked against whatever prod happens to hold today, which is how the last
 * two versions of this comment came to state a ceiling nothing enforced.
 *
 * What makes it true is capLogFields on both write paths: scrapeLogs is
 * written by a public mutation whose matchConditions is v.any(), so without
 * it a signed-in caller decides what a row costs. Nothing prunes this table
 * either, so a page that outgrew its budget would have stayed broken.
 *
 * Moving rawResponse off the row is what would raise this, by making the
 * read cheap rather than small; until then the page says when it is showing
 * a slice.
 */
const QUERY_READ_BUDGET_BYTES = 8_000_000;
const MAX_LIST_LIMIT = Math.floor(QUERY_READ_BUDGET_BYTES / MAX_LOG_ROW_BYTES);

/**
 * The fields the list renders, and nothing else. Saves sending the AI
 * narrative and the raw response to a page that shows neither.
 */
function summarise(log: Doc<"scrapeLogs">) {
  return {
    _id: log._id,
    url: log.url,
    status: log.status,
    createdAt: log.createdAt,
    durationMs: log.durationMs,
    monitorId: log.monitorId,
    monitorName: log.monitorName,
    itemCount: log.itemCount,
    matchCount: log.matchCount,
    error: log.error,
    strategy: log.strategy,
    blocked: log.blocked,
    retryAttempt: log.retryAttempt,
  };
}

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const now = Date.now();
    const identity = await ctx.auth.getUserIdentity();
    // null, not the free window. Convex identity arrives over its own socket
    // rather than with the Better Auth token, so every user — paying ones
    // included — is briefly unauthenticated here. Naming a window now would
    // tell a Pro user they are on 7 days before we have looked.
    if (!identity) {
      return { logs: [], windowDays: null, capped: false };
    }

    const safeLimit = Math.min(Math.max(Math.floor(limit ?? 50), 1), MAX_LIST_LIMIT);
    const { windowDays, cutoff } = await windowFor(ctx, identity.subject, now);

    // One over the limit, so the page can say it is showing a slice without
    // counting a window that could hold tens of thousands of rows.
    const page = await ctx.db
      .query("scrapeLogs")
      .withIndex("by_userId_createdAt", (q) =>
        q.eq("userId", identity.subject).gte("createdAt", cutoff)
      )
      .order("desc")
      .take(safeLimit + 1);

    return {
      logs: page.slice(0, safeLimit).map(summarise),
      windowDays,
      capped: page.length > safeLimit,
    };
  },
});

/**
 * Rows deleted per run of purgeForUser. A Max user on 5-minute checks writes
 * ~300 logs a day per monitor, and a row can reach MAX_LOG_ROW_BYTES (~60KB),
 * so one transaction cannot hold a heavy user's history: it runs in batches
 * and reschedules itself until the index is empty.
 *
 * 25 rather than 100 because of that row size: a hundred heavy rows is ~6MB
 * read and written in one transaction, close enough to Convex's limits that
 * the batch that trips it is the one belonging to the user with the most
 * history.
 */
const PURGE_BATCH = 25;

/** Deletes a user's check history. Scheduled by account.deleteAllUserData. */
export const purgeForUser = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const batch = await ctx.db
      .query("scrapeLogs")
      .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
      .take(PURGE_BATCH);
    for (const log of batch) {
      await ctx.db.delete(log._id);
    }
    if (batch.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.logs.purgeForUser, { userId });
    }
  },
});

/**
 * Checks the purge chain actually finished, and shouts if it did not.
 *
 * The chain only continues from inside a run that succeeded, so one throw ends
 * it silently with half a user's history still on disk — and the privacy page
 * says that history is gone within minutes. Nothing else would ever notice.
 * Scheduled by deleteAllUserData for well after the chain should be done.
 */
export const auditPurge = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const leftover = await ctx.db
      .query("scrapeLogs")
      .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
      .take(1);
    if (leftover.length === 0) return;
    await ctx.scheduler.runAfter(0, internal.admin.notify, {
      text: `⚠️ Check history survived account deletion for ${userId}. The purge chain stopped early — delete the rest by hand.`,
    });
  },
});

export const get = query({
  args: { id: v.id("scrapeLogs") },
  handler: async (ctx, { id }) => {
    const now = Date.now();
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { log: null, outsideWindow: false, windowDays: null, upgradeWouldShow: false };
    }

    const { tier, windowDays } = await windowFor(ctx, identity.subject, now);
    const log = await ctx.db.get(id);
    if (!log || log.userId !== identity.subject) {
      return { log: null, outsideWindow: false, windowDays, upgradeWouldShow: false };
    }

    // A link kept from before a downgrade. The row is still there, so say so
    // rather than "not found", which reads as data we lost.
    if (!isWithinHistoryWindow(log.createdAt, tier, now)) {
      return {
        log: null,
        outsideWindow: true,
        windowDays,
        // Whether buying something would actually reach this row, which is
        // not the same as a bigger plan existing: a 91-day-old check is past
        // every window there is, so a Free user must not be promised it back.
        upgradeWouldShow: isWithinHistoryWindow(log.createdAt, "max", now),
      };
    }

    return { log, outsideWindow: false, windowDays, upgradeWouldShow: false };
  },
});
