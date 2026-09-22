import { v } from "convex/values";
import { mutation, query, internalMutation, type QueryCtx } from "./_generated/server";
import { HISTORY_WINDOW_DAYS, historyCutoff, isWithinHistoryWindow } from "@prowl/shared";
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
 * The fields the list renders, and nothing else.
 *
 * rawResponse is the big one — a single row of it has reached 11KB — and the
 * list has never shown it; the AI narrative is only read on the detail page.
 * Sending the whole document for 500 rows was paying egress for fields nobody
 * was going to look at.
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
    if (!identity) {
      return { logs: [], windowDays: HISTORY_WINDOW_DAYS.free, capped: false };
    }

    const safeLimit = Math.min(Math.max(Math.floor(limit ?? 50), 1), 500);
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

export const get = query({
  args: { id: v.id("scrapeLogs") },
  handler: async (ctx, { id }) => {
    const now = Date.now();
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { log: null, outsideWindow: false, windowDays: HISTORY_WINDOW_DAYS.free };

    const { tier, windowDays } = await windowFor(ctx, identity.subject, now);
    const log = await ctx.db.get(id);
    if (!log || log.userId !== identity.subject) {
      return { log: null, outsideWindow: false, windowDays };
    }

    // A link kept from before a downgrade. The row is still there, so say so
    // rather than "not found", which reads as data we lost.
    if (!isWithinHistoryWindow(log.createdAt, tier, now)) {
      return { log: null, outsideWindow: true, windowDays };
    }

    return { log, outsideWindow: false, windowDays };
  },
});
