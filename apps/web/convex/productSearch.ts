import { ConvexError, v } from "convex/values";
import { z } from "zod";
import { action, internalMutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireLiveAccount } from "./account";
import { activityRow } from "./betaFeatures";
import { effectiveTier, type Tier } from "./tiers";
import { isSearchRegion, type ProductListing } from "@prowl/shared";

const DAILY_SEARCH_LIMITS: Record<Tier, number> = { free: 5, sprint: 15, pro: 30, max: 100 };

/**
 * Paid calls allowed per day, refunded or not. Refunds keep failed searches
 * off the user's count, so without this a broken or gamed search could be
 * retried, and billed, without end.
 */
const attemptCeiling = (limit: number) => Math.max(10, 3 * limit);

/** Today as a UTC date, the same day every other allowance in tiers.ts counts. */
const today = () => new Date().toISOString().slice(0, 10);

const listingSchema = z.object({
  site: z.string(),
  url: z.string(),
  title: z.string(),
  price: z.number().int().nullable(),
  currency: z.string().nullable(),
  inStock: z.boolean().nullable(),
  label: z.enum(["same", "similar", "accessory"]),
});
const scraperResponse = z.object({ listings: z.array(listingSchema).max(8) });

function tierRow(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query("userTiers")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

/**
 * The user's search count, the day it was counted on, and their last region.
 * The client compares `day` with its own UTC date, because a query can't read
 * the clock: a count from yesterday means a full allowance today.
 */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const record = await tierRow(ctx, identity.subject);
    const activity = await activityRow(ctx, identity.subject);
    return {
      day: record?.productSearchDay ?? null,
      used: record?.productSearchCount ?? 0,
      limit: DAILY_SEARCH_LIMITS[effectiveTier(record)],
      region: activity?.searchRegion ?? null,
    };
  },
});

/**
 * Count one search against today's allowance, or refuse.
 *
 * Runs before the scraper call, in a mutation, so two searches started at
 * once cannot both read "4 used" and both go through. Also saves
 * `saveRegion` as the user's default, which costs nothing extra here.
 */
export const reserve = internalMutation({
  args: { userId: v.string(), saveRegion: v.optional(v.string()) },
  handler: async (ctx, { userId, saveRegion }): Promise<{ day: string }> => {
    await requireLiveAccount(ctx, userId);
    const activity = await activityRow(ctx, userId);
    if (!activity?.betaFeatures?.includes("find_a_product")) {
      throw new ConvexError("Find a product is a beta feature. Turn it on in Settings.");
    }

    const day = today();
    const record = await tierRow(ctx, userId);
    const limit = DAILY_SEARCH_LIMITS[effectiveTier(record)];
    const isToday = record?.productSearchDay === day;
    const used = isToday ? (record?.productSearchCount ?? 0) : 0;
    const attempts = isToday ? (record?.productSearchAttempts ?? 0) : 0;
    if (used >= limit) {
      throw new ConvexError(`You've used all ${limit} searches for today. Paste a URL instead, or search again tomorrow.`);
    }
    if (attempts >= attemptCeiling(limit)) {
      throw new ConvexError("Search isn't working for you today. Paste a URL instead, or try again tomorrow.");
    }

    const counts = { productSearchDay: day, productSearchCount: used + 1, productSearchAttempts: attempts + 1 };
    if (record) {
      await ctx.db.patch(record._id, counts);
    } else {
      await ctx.db.insert("userTiers", { userId, tier: "free", ...counts, updatedAt: Date.now() });
    }

    if (saveRegion !== undefined && activity.searchRegion !== saveRegion) {
      await ctx.db.patch(activity._id, { searchRegion: saveRegion });
    }

    return { day };
  },
});

/**
 * Give back a search that failed or found nothing. Takes the day it was
 * reserved on, so one that fails across UTC midnight does not take a search
 * off the new day's count. Attempts are never given back.
 */
export const refund = internalMutation({
  args: { userId: v.string(), day: v.string() },
  handler: async (ctx, { userId, day }) => {
    const record = await tierRow(ctx, userId);
    const used = record?.productSearchCount ?? 0;
    if (!record || record.productSearchDay !== day || used <= 0) return;
    await ctx.db.patch(record._id, { productSearchCount: used - 1 });
  },
});

/**
 * Run one paid search, counted against the user's day: reserved first, and
 * given back if it fails or finds nothing. Returns the day it was counted
 * on, for a caller that has its own reason to give it back.
 */
async function findListings(
  ctx: ActionCtx,
  userId: string,
  args: { query: string; region: string; saveRegion: boolean }
): Promise<{ listings: ProductListing[]; day: string }> {
  const query = args.query.trim();
  const { region } = args;
  if (query.length < 2 || query.length > 200) throw new ConvexError("Type a product name.");
  if (!isSearchRegion(region)) throw new ConvexError("Pick a country to search.");

  const scraperUrl = process.env.SCRAPER_URL;
  const scraperKey = process.env.SCRAPER_API_KEY;
  if (!scraperUrl || !scraperKey) {
    console.error("[productSearch] SCRAPER_URL or SCRAPER_API_KEY not configured");
    throw new ConvexError("Search isn't available right now.");
  }

  const { day } = await ctx.runMutation(internal.productSearch.reserve, {
    userId,
    ...(args.saveRegion ? { saveRegion: region } : {}),
  });

  let listings: ProductListing[];
  try {
    const res = await fetch(`${scraperUrl}/api/find-listings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": scraperKey },
      body: JSON.stringify({ query, region, userId }),
      // The scraper stops itself at 110s, so this only fires if it hangs.
      signal: AbortSignal.timeout(150_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    listings = scraperResponse.parse(await res.json()).listings;
  } catch (error) {
    console.error("[productSearch] Search failed:", error instanceof Error ? error.message : String(error));
    await ctx.runMutation(internal.productSearch.refund, { userId, day });
    throw new ConvexError("The search didn't work. It hasn't counted toward today's limit.");
  }

  if (listings.length === 0) await ctx.runMutation(internal.productSearch.refund, { userId, day });
  return { listings, day };
}

export const search = action({
  args: { query: v.string(), region: v.string() },
  handler: async (ctx, args): Promise<ProductListing[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Sign in to search.");
    const { listings } = await findListings(ctx, identity.subject, { ...args, saveRegion: true });
    return listings;
  },
});

/**
 * Search again for a product's name and region, and add what's new to it as
 * suggestions. Counts toward the daily limit like any search, even when all
 * it finds is already in the product. Given back if nothing could be added
 * because the product filled up, or was deleted, during the search. Returns
 * the URLs it added, and whether the product filled up before everything new
 * fit.
 */
export const findMore = action({
  args: { groupId: v.id("monitorGroups") },
  handler: async (ctx, { groupId }): Promise<{ added: string[]; full: boolean }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Sign in to search.");
    const userId = identity.subject;

    // Before the search is counted, so a product the user can't add to costs nothing.
    const { name, region } = await ctx.runQuery(internal.monitorGroups.searchTarget, { userId, id: groupId });
    // The product's region is not saved as the user's default: that is the
    // region they last searched by hand.
    const { listings, day } = await findListings(ctx, userId, { query: name, region, saveRegion: false });
    if (listings.length === 0) return { added: [], full: false };

    const result = await ctx.runMutation(internal.monitorGroups.addSuggestions, {
      userId,
      id: groupId,
      listings: listings.map((l) => ({
        ...l,
        price: l.price ?? undefined,
        currency: l.currency ?? undefined,
        inStock: l.inStock ?? undefined,
      })),
    });
    if (result === null || (result.full && result.added.length === 0)) {
      await ctx.runMutation(internal.productSearch.refund, { userId, day });
    }
    return result ?? { added: [], full: false };
  },
});
