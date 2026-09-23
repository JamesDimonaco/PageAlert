import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

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
      ...args,
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
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const safeLimit = Math.min(Math.max(Math.floor(limit ?? 50), 1), 500);

    return ctx.db
      .query("scrapeLogs")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(safeLimit);
  },
});

/**
 * Rows deleted per run of purgeForUser. A Max user on 5-minute checks writes
 * ~300 logs a day per monitor, and rawResponse alone can be 50KB, so one
 * transaction cannot hold a heavy user's history: it runs in batches and
 * reschedules itself until the index is empty.
 *
 * 25 rather than 100 because of that 50KB: a hundred heavy rows is ~5MB read
 * and written in one transaction, close enough to Convex's limits that the
 * batch that trips it is the one belonging to the user with the most history.
 */
const PURGE_BATCH = 25;

/** Deletes a user's check history. Scheduled by account.deleteAllUserData. */
export const purgeForUser = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const batch = await ctx.db
      .query("scrapeLogs")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
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
      .withIndex("by_userId", (q) => q.eq("userId", userId))
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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const log = await ctx.db.get(id);
    if (!log || log.userId !== identity.subject) return null;
    return log;
  },
});
