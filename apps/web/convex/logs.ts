import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";

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
