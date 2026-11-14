import { ConvexError, v, type Infer } from "convex/values";
import { action, mutation, query, type QueryCtx } from "./_generated/server";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  DEFAULT_AGENT_MATCHES,
  MAX_AGENT_MATCHES,
  MAX_AGENT_MONITORS,
  guessAlertOn,
  isComparisonSite,
  isProductMonitor,
  itemIdentity,
  toAgentItem,
  toMinorUnits,
  type AgentItem,
  type ProductListing,
} from "@prowl/shared";
import { reserveFallback, scraperDown } from "./admin";
import { requireKeyOwner } from "./apiKeys";
import {
  claimFirstScanProxyForUser,
  createMonitorForUser,
  removeMonitorsForUser,
  saveScanErrorForUser,
  saveScanResultForUser,
  updateMonitorForUser,
} from "./monitors";
import { createFolderForUser, setMonitorFolder, setProductFolder } from "./folders";
import { createProductForUser } from "./monitorGroups";
import { findListings } from "./productSearch";
import { alertOnValidator, checkIntervalValidator } from "./schema";
import { displayHost, matchKey, previewUserPrefix } from "./shared";

/**
 * What the MCP route calls, one function per tool step. Each takes the raw API
 * key and resolves the owner itself, so nothing here trusts a userId from the
 * caller.
 *
 * Errors are ConvexErrors carrying a ToolError on purpose: Convex hides a
 * plain Error's message from clients in production, and an agent told only
 * "Server Error" cannot tell a creation limit from a bad URL.
 */

export type ToolErrorCode = "blocked" | "limit_reached" | "not_found" | "invalid_url" | "failed";
/** What every MCP tool returns on failure. `retry` says whether the same call may work later. */
export type ToolError = { code: ToolErrorCode; message: string; retry: boolean };

/**
 * Sort a helper's error message into a code. The helpers are shared with the
 * web app and throw plain messages, so the message is all there is to go on.
 * Retry is true only when the message says the problem passes with time:
 * a rolling or daily limit, a service that is down "right now", or a failed
 * search that was not counted.
 */
function toolError(message: string): ToolError {
  const retry = /another in|tomorrow|right now|try again|didn't work/i.test(message);
  if (/not found/i.test(message)) return { code: "not_found", message, retry: false };
  if (/limit reached|plan allows|used all/i.test(message)) return { code: "limit_reached", message, retry };
  // Before the URL rule: "Paste a URL instead, or try again tomorrow" is advice, not a bad URL.
  if (retry) return { code: "failed", message, retry };
  if (/\burls?\b|\blinks?\b|hostname/i.test(message)) return { code: "invalid_url", message, retry: false };
  return { code: "failed", message, retry };
}

function asToolError(e: unknown): never {
  if (e instanceof ConvexError && typeof e.data === "object") throw e;
  if (e instanceof ConvexError) throw new ConvexError(toolError(String(e.data)));
  throw new ConvexError(toolError(e instanceof Error ? e.message : "Something went wrong"));
}

/** Scan history rows looked through for matches. Most checks find nothing, so this is a lookback, not a page size. */
const MATCH_LOOKBACK_RESULTS = 50;

async function ownedMonitor(ctx: QueryCtx, userId: string, monitorId: string) {
  const id = ctx.db.normalizeId("monitors", monitorId);
  const monitor = id ? await ctx.db.get(id) : null;
  if (!monitor || monitor.userId !== userId) throw new ConvexError(toolError("Monitor not found"));
  return monitor;
}

type AlertOn = Infer<typeof alertOnValidator>;

/** Stock and price alerts read from the prompt, for an agent that sent none. */
function guessedAlertOn(prompt: string): AlertOn | undefined {
  const guess = guessAlertOn(prompt);
  const currency = guess.priceBelow?.currency;
  const amount = guess.priceBelow && currency ? toMinorUnits(guess.priceBelow.amount, currency) : null;
  const alertOn: AlertOn = {
    ...(guess.backInStock ? { backInStock: true } : {}),
    ...(amount !== null && currency ? { priceBelow: { amount, currency } } : guess.priceDrop ? { priceDrop: true } : {}),
  };
  return Object.keys(alertOn).length > 0 ? alertOn : undefined;
}

/** Said when stock or price alerts are on but the page is not a product page, so they will not run. */
function notAProductNote(url: string): string {
  return isComparisonSite(url)
    ? "This is a price comparison page, so stock and price alerts don't run on it and only prompt alerts fire. " +
        "Put the target in the prompt instead, e.g. 'lowest in-stock price under $300'."
    : "Stock and price alerts only run on a product page. This page reads as a listing, so only match alerts will fire.";
}

function wantsProductAlerts(alertOn: AlertOn | undefined): boolean {
  return alertOn?.backInStock === true || alertOn?.priceDrop === true || alertOn?.priceBelow !== undefined;
}

function isoOrNull(time: number | undefined): string | null {
  return time === undefined ? null : new Date(time).toISOString();
}

/** A monitor as list_monitors and update_monitor show it. */
function agentMonitor(m: Doc<"monitors">, folder: string | null) {
  return {
    id: m._id,
    name: m.name,
    url: m.url,
    shop: displayHost(m.url),
    prompt: m.prompt,
    status: m.status,
    checkInterval: m.checkInterval,
    alertOn: m.alertOn ?? null,
    productId: m.groupId ?? null,
    lastCheckedAt: isoOrNull(m.lastCheckedAt),
    matchCount: m.matchCount,
    // checkCount counts successful checks only, so zero means we have never
    // once read this page.
    neverSucceeded: (m.checkCount ?? 0) === 0,
    folder,
  };
}

/** A product's listings are filed with the product. */
async function folderNameOf(ctx: QueryCtx, m: Doc<"monitors">): Promise<string | null> {
  const folderId = m.groupId ? (await ctx.db.get(m.groupId))?.folderId : m.folderId;
  return folderId ? ((await ctx.db.get(folderId))?.name ?? null) : null;
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
    const folders = await ctx.db.query("folders").withIndex("by_userId", (q) => q.eq("userId", userId)).collect();
    const folderName = new Map(folders.map((f) => [f._id, f.name]));
    const products = await ctx.db.query("monitorGroups").withIndex("by_userId", (q) => q.eq("userId", userId)).collect();
    const productFolder = new Map(products.map((p) => [p._id, p.folderId]));
    return monitors.map((m) => {
      const folderId = m.groupId ? productFolder.get(m.groupId) : m.folderId;
      return agentMonitor(m, (folderId && folderName.get(folderId)) ?? null);
    });
  },
});

/** A product and what each of its watched shop pages last read. */
export const getProduct = query({
  args: { apiKey: v.string(), productId: v.string() },
  handler: async (ctx, { apiKey, productId }) => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    const id = ctx.db.normalizeId("monitorGroups", productId);
    const product = id ? await ctx.db.get(id) : null;
    if (!product || product.userId !== userId) throw new ConvexError(toolError("Product not found"));
    const folder = product.folderId ? ((await ctx.db.get(product.folderId))?.name ?? null) : null;
    // Listings are capped (see monitorGroups.ts), so this read is too.
    const monitors = await Promise.all(product.listings.map((l) => (l.monitorId ? ctx.db.get(l.monitorId) : null)));
    return {
      id: product._id,
      name: product.name,
      region: product.region,
      alertOn: product.alertOn,
      checkInterval: product.checkInterval,
      folder,
      listings: monitors
        .filter((m) => m !== null)
        .map((m) => ({
          monitorId: m._id,
          shop: displayHost(m.url),
          url: m.url,
          status: m.status,
          inStock: m.lastSeen?.inStock ?? null,
          price: m.lastSeen?.price ?? null,
          currency: m.lastSeen?.currency ?? null,
          lastCheckedAt: isoOrNull(m.lastCheckedAt),
          lastError: m.lastError ?? null,
        })),
    };
  },
});

/**
 * A monitor's matched items, newest first, each dated from the oldest row it
 * appears in. A full extract stores every current match, not only the new
 * ones, so an item on the page for a week is in every row.
 */
async function datedMatches(ctx: QueryCtx, monitorId: Id<"monitors">): Promise<(AgentItem & { matchedAt: number })[]> {
  const results = await ctx.db
    .query("scrapeResults")
    .withIndex("by_monitorId_scrapedAt", (q) => q.eq("monitorId", monitorId))
    .order("desc")
    .take(MATCH_LOOKBACK_RESULTS);
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
  return [...byIdentity.values()].sort((a, b) => b.matchedAt - a.matchedAt);
}

/**
 * The items a monitor alerted on since a time, each dated from its latest
 * alert, so a restock counts from the restock. A full read's row lists every
 * current match, so only those it recorded as new count. Full-read rows from
 * before that was recorded are skipped: there is no telling what was new.
 */
async function alertedSince(ctx: QueryCtx, monitorId: Id<"monitors">, from: number): Promise<(AgentItem & { matchedAt: number })[]> {
  const results = await ctx.db
    .query("scrapeResults")
    .withIndex("by_monitorId_scrapedAt", (q) => q.eq("monitorId", monitorId).gte("scrapedAt", from))
    .order("desc")
    .take(MAX_RECENT_ROWS);
  const byIdentity = new Map<string, AgentItem & { matchedAt: number }>();
  for (const result of results) {
    if (!result.hasNewMatches || (result.items !== undefined && result.newMatchKeys === undefined)) continue;
    const fresh = result.newMatchKeys ? new Set(result.newMatchKeys) : null;
    for (const raw of result.matches) {
      if (fresh && !fresh.has(matchKey(raw))) continue;
      const item = toAgentItem(raw);
      if (!item) continue;
      const key = itemIdentity(item);
      // Newest row first, so the first sighting is the latest alert.
      if (!byIdentity.has(key)) byIdentity.set(key, { ...item, matchedAt: result.scrapedAt });
    }
  }
  return [...byIdentity.values()];
}

export const getMatches = query({
  args: { apiKey: v.string(), monitorId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { apiKey, monitorId, limit }) => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    const monitor = await ownedMonitor(ctx, userId, monitorId);
    const max = Math.min(Math.max(Math.floor(limit ?? DEFAULT_AGENT_MATCHES), 1), MAX_AGENT_MATCHES);
    return (await datedMatches(ctx, monitor._id))
      .slice(0, max)
      .map((m) => ({ ...m, matchedAt: new Date(m.matchedAt).toISOString() }));
  },
});

/**
 * Monitors read by one recent-matches call, and result rows read per monitor.
 * Rows average about 2KB on prod (measured 2026-11-13), so a call reads about
 * 8MB at most. A row that scored 25 entries is larger. 200 rows is two days
 * of a 15-minute monitor.
 */
const MAX_RECENT_MATCH_MONITORS = 20;
const MAX_RECENT_ROWS = 200;

/**
 * New matches across all of a user's monitors since a time, newest first.
 * Picks monitors by lastMatchAt, which only moves on a new match; matchCount
 * is a per-check total and says nothing about what is new. A product's
 * listings are left out, because they never send match alerts.
 */
export const getRecentMatches = query({
  args: { apiKey: v.string(), since: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { apiKey, since, limit }) => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    const max = Math.min(Math.max(Math.floor(limit ?? DEFAULT_AGENT_MATCHES), 1), MAX_AGENT_MATCHES);
    const from = Date.parse(since);
    if (Number.isNaN(from)) throw new ConvexError(toolError("since must be an ISO 8601 time, e.g. 2026-11-13T00:00:00Z."));
    // The plan's monitor limit bounds this read.
    const monitors = (
      await ctx.db.query("monitors").withIndex("by_userId", (q) => q.eq("userId", userId)).collect()
    )
      .filter((m) => m.groupId === undefined && m.lastMatchAt !== undefined && m.lastMatchAt >= from)
      .sort((a, b) => b.lastMatchAt! - a.lastMatchAt!)
      .slice(0, MAX_RECENT_MATCH_MONITORS);
    const perMonitor = await Promise.all(monitors.map((m) => alertedSince(ctx, m._id, from)));
    const recent = monitors.flatMap((monitor, i) =>
      perMonitor[i]!.map((match) => ({ ...match, monitorId: monitor._id, monitorName: monitor.name }))
    );
    return recent
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
    checkInterval: v.optional(checkIntervalValidator),
    alertOn: v.optional(alertOnValidator),
    folderId: v.optional(v.string()),
  },
  handler: async (ctx, { apiKey, checkInterval, alertOn, folderId, ...args }): Promise<Id<"monitors">> => {
    const owner = await requireKeyOwner(ctx, apiKey);
    const id = await createMonitorForUser(ctx, owner, {
      ...args,
      // Same default as the web form.
      checkInterval: checkInterval ?? "1h",
      alertOn: alertOn ?? guessedAlertOn(args.prompt),
    }).catch(asToolError);
    // A throw here rolls back the monitor too.
    if (folderId !== undefined) await setMonitorFolder(ctx, owner.userId, id, folderId).catch(asToolError);
    return id;
  },
});

export const updateMonitor = mutation({
  args: {
    apiKey: v.string(),
    monitorId: v.string(),
    name: v.optional(v.string()),
    prompt: v.optional(v.string()),
    checkInterval: v.optional(checkIntervalValidator),
    alertOn: v.optional(alertOnValidator),
    paused: v.optional(v.boolean()),
    /** Null takes the monitor out of its folder. */
    folderId: v.optional(v.union(v.string(), v.null())),
    // Accepted only to refuse it with a reason. Left out of the args, it would
    // be rejected as an unknown field with a message no agent can act on.
    url: v.optional(v.string()),
  },
  handler: async (ctx, { apiKey, monitorId, url, paused, folderId, ...fields }) => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    const monitor = await ownedMonitor(ctx, userId, monitorId);
    // A product's listings share its alerts and interval. One changed alone
    // would alert unlike the rest, and the product page would not show it.
    if (monitor.groupId && (fields.alertOn !== undefined || fields.checkInterval !== undefined)) {
      throw new ConvexError(toolError("This monitor is part of a product, which sets its alerts and check interval."));
    }
    if (url !== undefined) {
      throw new ConvexError<ToolError>({
        code: "invalid_url",
        message: "A monitor's URL can't change. Delete it and create a new one.",
        retry: false,
      });
    }
    // The scan saves its status and its reading of the old prompt when it
    // ends, so a pause or a new prompt now would not take.
    if ((paused === true || fields.prompt !== undefined) && monitor.status === "scanning") {
      throw new ConvexError(toolError("The first scan is still running. Try again in a minute."));
    }
    // Resuming a monitor that is not paused changes nothing.
    const status =
      paused === true ? ("paused" as const)
      : paused === false && monitor.status === "paused" ? ("active" as const)
      : undefined;
    await updateMonitorForUser(ctx, userId, monitor._id, { ...fields, status }).catch(asToolError);
    // The web app asks the user to rescan after a new prompt; an agent has no
    // rescan. Due now, the next check re-reads the page with the new prompt.
    // The old prompt's seen set and sold-out queue go too: the quick check
    // after the re-read then seeds them silently, rather than announcing what
    // the re-read already did.
    if (fields.prompt !== undefined && fields.prompt.trim() !== monitor.prompt) {
      await ctx.db.patch(monitor._id, {
        lastAiExtractAt: 0,
        contentFingerprint: undefined,
        candidateKeys: undefined,
        passedKeys: undefined,
        candidatePrices: undefined,
        soldOutKeys: undefined,
        soldOutTextHashes: undefined,
      });
    }
    if (folderId !== undefined) {
      // A product's listings are filed with the product, and agents have no
      // tool to move a product, so filing a listing files its product.
      const filing = monitor.groupId
        ? setProductFolder(ctx, userId, monitor.groupId, folderId)
        : setMonitorFolder(ctx, userId, monitor._id, folderId);
      await filing.catch(asToolError);
    }
    const saved = (await ctx.db.get(monitor._id))!;
    const note = wantsProductAlerts(saved.alertOn) && !isProductMonitor(saved) ? notAProductNote(saved.url) : null;
    return { ...agentMonitor(saved, await folderNameOf(ctx, saved)), ...(note ? { note } : {}) };
  },
});

export const deleteMonitor = mutation({
  args: { apiKey: v.string(), monitorId: v.string() },
  handler: async (ctx, { apiKey, monitorId }) => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    const monitor = await ownedMonitor(ctx, userId, monitorId);
    await removeMonitorsForUser(ctx, userId, [monitor._id]).catch(asToolError);
    return { deleted: monitor._id };
  },
});

/**
 * Search shops for a product, as the web app's "Find a product" does: the
 * same daily allowance, and a failed search is given back.
 */
export const findProduct = action({
  args: { apiKey: v.string(), query: v.string(), region: v.string() },
  handler: async (ctx, { apiKey, ...args }): Promise<ProductListing[]> => {
    const owner = await ctx.runMutation(api.apiKeys.verify, { key: apiKey });
    if (!owner) throw new ConvexError("Invalid API key");
    // The region is not saved as the user's default: that is what they last picked by hand.
    const { listings } = await findListings(ctx, owner.userId, { ...args, saveRegion: false }).catch(asToolError);
    return listings;
  },
});

/** Watch one product across the shop pages an agent picked, with one set of stock and price alerts. */
export const createProduct = mutation({
  args: {
    apiKey: v.string(),
    title: v.string(),
    region: v.string(),
    urls: v.array(v.string()),
    alertOn: alertOnValidator,
    checkInterval: v.optional(checkIntervalValidator),
    folderId: v.optional(v.string()),
  },
  handler: async (ctx, { apiKey, title, region, urls, alertOn, checkInterval, folderId }) => {
    const owner = await requireKeyOwner(ctx, apiKey);
    const { groupId, monitorIds } = await createProductForUser(ctx, owner, {
      name: title,
      region,
      alertOn,
      notificationChannels: undefined,
      checkInterval: checkInterval ?? "1h",
      listings: urls.map((url) => ({ site: displayHost(url), url, title, label: "same" as const, watch: true })),
    }).catch(asToolError);
    if (folderId !== undefined) await setProductFolder(ctx, owner.userId, groupId, folderId).catch(asToolError);
    return { productId: groupId, monitorIds };
  },
});

/** A folder by name: the user's existing one with that name, or a new one. */
export const createFolder = mutation({
  args: { apiKey: v.string(), name: v.string() },
  handler: async (ctx, { apiKey, name }) => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    const folderId = await createFolderForUser(ctx, userId, name).catch(asToolError);
    const folder = await ctx.db.get(folderId);
    return { folderId, name: folder!.name };
  },
});

/** Proxy reads a preview may spend per user per UTC day. Each one costs proxy credit. */
const PREVIEW_PROXY_DAILY_LIMIT = 5;
/**
 * Proxy reads all previews together may spend in an hour. Previews have
 * their own bucket rather than the monitors' escalation budget, so a few busy
 * agents cannot leave real monitors without their proxy retries.
 */
const PREVIEW_PROXY_HOURLY_LIMIT = 20;

const PREVIEW_HOUR_PREFIX = "previewProxy:hour:";

/**
 * Claim one proxy attempt for a preview the site blocked. Counted per user
 * per UTC day, and drawn from the fleet's proxy budget like a first scan's.
 */
export const claimPreviewProxy = mutation({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }): Promise<{ granted: true } | { granted: false; reason: string }> => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    const now = new Date().toISOString();
    const counter = (name: string) => ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();
    const userName = `${previewUserPrefix(userId)}${now.slice(0, 10)}`;
    const hourName = `${PREVIEW_HOUR_PREFIX}${now.slice(0, 13)}`;
    const user = await counter(userName);
    if ((user?.value ?? 0) >= PREVIEW_PROXY_DAILY_LIMIT) {
      return { granted: false, reason: `This account has used its ${PREVIEW_PROXY_DAILY_LIMIT} proxy previews for today.` };
    }
    const hour = await counter(hourName);
    // The monthly budget is the one about money; the hourly one is previews' own.
    if ((hour?.value ?? 0) >= PREVIEW_PROXY_HOURLY_LIMIT || (await scraperDown(ctx)) || !(await reserveFallback(ctx, false))) {
      return { granted: false, reason: "The proxy is not available right now." };
    }
    for (const [row, name, prefix] of [[user, userName, previewUserPrefix(userId)], [hour, hourName, PREVIEW_HOUR_PREFIX]] as const) {
      if (row) {
        await ctx.db.patch(row._id, { value: row.value + 1 });
        continue;
      }
      await ctx.db.insert("counters", { name, value: 1 });
      // Only the current day's and hour's rows are still read. Names end in an
      // ISO date or hour, so the earlier ones sort before this one.
      const stale = await ctx.db
        .query("counters")
        .withIndex("by_name", (q) => q.gte("name", prefix).lt("name", name))
        .take(48);
      for (const old of stale) await ctx.db.delete(old._id);
    }
    return { granted: true };
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
  handler: async (ctx, { apiKey, matches, ...args }): Promise<{ note?: string }> => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    const monitor = await ownedMonitor(ctx, userId, args.id);
    await saveScanResultForUser(ctx, userId, { ...args, matches, matchCount: matches.length }).catch(asToolError);
    return wantsProductAlerts(monitor.alertOn) && !isProductMonitor({ ...monitor, schema: args.schema })
      ? { note: notAProductNote(monitor.url) }
      : {};
  },
});

/**
 * The dashboard's knownHost claim: a site known to need the proxy (Costco, or
 * one other live monitors read through it) skips a direct first scan that
 * would only come back empty or blocked.
 */
export const claimFirstScanProxy = mutation({
  args: { apiKey: v.string(), id: v.id("monitors") },
  handler: async (ctx, { apiKey, id }) => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    await ownedMonitor(ctx, userId, id);
    return await claimFirstScanProxyForUser(ctx, userId, { id, knownHost: true }).catch(asToolError);
  },
});

export const saveScanError = mutation({
  args: { apiKey: v.string(), id: v.id("monitors"), error: v.string() },
  handler: async (ctx, { apiKey, ...args }) => {
    const { userId } = await requireKeyOwner(ctx, apiKey);
    await ownedMonitor(ctx, userId, args.id);
    await saveScanErrorForUser(ctx, userId, args).catch(asToolError);
  },
});
