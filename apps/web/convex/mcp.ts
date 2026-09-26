import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  DEFAULT_AGENT_MATCHES,
  MAX_AGENT_MATCHES,
  MAX_AGENT_MONITORS,
  itemIdentity,
  toAgentItem,
  type AgentItem,
} from "@prowl/shared";
import { requireKeyOwner } from "./apiKeys";
import {
  createMonitorForUser,
  intervalValidator,
  saveScanErrorForUser,
  saveScanResultForUser,
} from "./monitors";

/**
 * What the MCP route calls, one function per tool step. Each takes the raw API
 * key and resolves the owner itself, so nothing here trusts a userId from the
 * caller.
 *
 * Errors are ConvexErrors on purpose: Convex hides a plain Error's message
 * from clients in production, and an agent told only "Server Error" cannot
 * tell a creation limit from a bad URL.
 */

/** Scan history rows looked through for matches. Most checks find nothing, so this is a lookback, not a page size. */
const MATCH_LOOKBACK_RESULTS = 50;

function asUserError(e: unknown): never {
  if (e instanceof ConvexError) throw e;
  throw new ConvexError(e instanceof Error ? e.message : "Something went wrong");
}

async function ownedMonitor(ctx: QueryCtx, userId: string, monitorId: string) {
  const id = ctx.db.normalizeId("monitors", monitorId);
  const monitor = id ? await ctx.db.get(id) : null;
  if (!monitor || monitor.userId !== userId) throw new ConvexError("Monitor not found");
  return monitor;
}

export const listMonitors = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    const monitors = await ctx.db
      .query("monitors")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_AGENT_MONITORS);
    return monitors.map((m) => ({
      id: m._id,
      name: m.name,
      url: m.url,
      status: m.status,
      checkInterval: m.checkInterval,
      lastCheckedAt: m.lastCheckedAt === undefined ? null : new Date(m.lastCheckedAt).toISOString(),
      matchCount: m.matchCount,
      // checkCount counts successful checks only, so zero means we have never
      // once read this page.
      neverSucceeded: (m.checkCount ?? 0) === 0,
    }));
  },
});

export const getMatches = query({
  args: { apiKey: v.string(), monitorId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { apiKey, monitorId, limit }) => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    const monitor = await ownedMonitor(ctx, userId, monitorId);
    const max = Math.min(Math.max(Math.floor(limit ?? DEFAULT_AGENT_MATCHES), 1), MAX_AGENT_MATCHES);

    const results = await ctx.db
      .query("scrapeResults")
      .withIndex("by_monitorId_scrapedAt", (q) => q.eq("monitorId", monitor._id))
      .order("desc")
      .take(MATCH_LOOKBACK_RESULTS);

    // A full extract stores every current match, not only the new ones, so an
    // item on the page for a week is in every row. Keep one entry per item,
    // dated from the oldest row it appears in.
    const byIdentity = new Map<string, AgentItem & { matchedAt: number }>();
    for (const result of results) {
      if (!result.hasNewMatches) continue;
      for (const raw of result.matches) {
        const item = toAgentItem(raw);
        if (!item) continue;
        const key = itemIdentity(item);
        const seen = byIdentity.get(key);
        if (seen) seen.matchedAt = result.scrapedAt;
        else byIdentity.set(key, { ...item, matchedAt: result.scrapedAt });
      }
    }
    return [...byIdentity.values()]
      .sort((a, b) => b.matchedAt - a.matchedAt)
      .slice(0, max)
      .map((m) => ({ ...m, matchedAt: new Date(m.matchedAt).toISOString() }));
  },
});

export const createMonitor = mutation({
  args: {
    apiKey: v.string(),
    url: v.string(),
    prompt: v.string(),
    name: v.string(),
    checkInterval: v.optional(intervalValidator),
  },
  handler: async (ctx, { apiKey, checkInterval, ...args }): Promise<Id<"monitors">> => {
    const owner = await requireKeyOwner(ctx, apiKey);
    // Same default as the web form.
    return createMonitorForUser(ctx, owner, { ...args, checkInterval: checkInterval ?? "1h" }).catch(asUserError);
  },
});

export const saveScanResult = mutation({
  args: {
    apiKey: v.string(),
    id: v.id("monitors"),
    schema: v.any(),
    matches: v.array(v.any()),
    contentFingerprint: v.optional(v.string()),
  },
  handler: async (ctx, { apiKey, matches, ...args }) => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    await ownedMonitor(ctx, userId, args.id);
    await saveScanResultForUser(ctx, userId, { ...args, matches, matchCount: matches.length }).catch(asUserError);
  },
});

export const saveScanError = mutation({
  args: { apiKey: v.string(), id: v.id("monitors"), error: v.string() },
  handler: async (ctx, { apiKey, ...args }) => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    await ownedMonitor(ctx, userId, args.id);
    await saveScanErrorForUser(ctx, userId, args).catch(asUserError);
  },
});
