import { ConvexError, v } from "convex/values";
import { action, internalMutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireLiveAccount } from "./account";
import { hasBetaFeature } from "./betaFeatures";
import { effectiveTier, type Tier } from "./tiers";
import { isSearchRegion, type ProductListing } from "@prowl/shared";

const DAILY_SEARCH_LIMITS: Record<Tier, number> = { free: 5, sprint: 15, pro: 30, max: 100 };

/** Today as a UTC date, the same day every other allowance in tiers.ts counts. */
const today = () => new Date().toISOString().slice(0, 10);

const listingValidator = v.object({
  site: v.string(),
  url: v.string(),
  title: v.string(),
  price: v.union(v.number(), v.null()),
  currency: v.union(v.string(), v.null()),
  inStock: v.union(v.boolean(), v.null()),
  label: v.union(v.literal("same"), v.literal("similar"), v.literal("accessory")),
});

function tierRow(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query("userTiers")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

function activityRow(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query("userActivity")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

/** Searches left today, and the region the user last searched. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const record = await tierRow(ctx, identity.subject);
    const limit = DAILY_SEARCH_LIMITS[effectiveTier(record)];
    const used = record?.productSearchDay === today() ? (record.productSearchCount ?? 0) : 0;
    const activity = await activityRow(ctx, identity.subject);
    return { remaining: Math.max(0, limit - used), limit, region: activity?.searchRegion ?? null };
  },
});

/**
 * Count one search against today's allowance, or refuse.
 *
 * Runs before the scraper call, in a mutation, so two searches started at
 * once cannot both read "4 used" and both go through. Also saves the region
 * as the user's default, which costs nothing extra here.
 */
export const reserve = internalMutation({
  args: { userId: v.string(), region: v.string() },
  handler: async (ctx, { userId, region }): Promise<{ day: string }> => {
    await requireLiveAccount(ctx, userId);
    if (!(await hasBetaFeature(ctx, userId, "find_a_product"))) {
      throw new ConvexError("Find a product is a beta feature. Turn it on in Settings.");
    }

    const day = today();
    const record = await tierRow(ctx, userId);
    const limit = DAILY_SEARCH_LIMITS[effectiveTier(record)];
    const used = record?.productSearchDay === day ? (record.productSearchCount ?? 0) : 0;
    if (used >= limit) {
      throw new ConvexError(`You've used all ${limit} searches for today. Paste a URL instead, or search again tomorrow.`);
    }

    if (record) {
      await ctx.db.patch(record._id, { productSearchDay: day, productSearchCount: used + 1 });
    } else {
      await ctx.db.insert("userTiers", {
        userId,
        tier: "free",
        productSearchDay: day,
        productSearchCount: 1,
        updatedAt: Date.now(),
      });
    }

    // The beta check above means this row exists.
    const activity = await activityRow(ctx, userId);
    if (activity && activity.searchRegion !== region) await ctx.db.patch(activity._id, { searchRegion: region });

    return { day };
  },
});

/**
 * Give back a search that failed or found nothing. Takes the day it was
 * reserved on, so one that fails across UTC midnight does not take a search
 * off the new day's count.
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

export const search = action({
  args: { query: v.string(), region: v.string() },
  returns: v.array(listingValidator),
  handler: async (ctx, args): Promise<ProductListing[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Sign in to search.");
    const userId = identity.subject;

    const query = args.query.trim();
    if (query.length < 2 || query.length > 200) throw new ConvexError("Type a product name.");
    if (!isSearchRegion(args.region)) throw new ConvexError("Pick a country to search.");

    const scraperUrl = process.env.SCRAPER_URL;
    const scraperKey = process.env.SCRAPER_API_KEY;
    if (!scraperUrl || !scraperKey) {
      console.error("[productSearch] SCRAPER_URL or SCRAPER_API_KEY not configured");
      throw new ConvexError("Search isn't available right now.");
    }

    const { day } = await ctx.runMutation(internal.productSearch.reserve, { userId, region: args.region });

    let listings: ProductListing[];
    try {
      const res = await fetch(`${scraperUrl}/api/find-listings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": scraperKey },
        body: JSON.stringify({ query, region: args.region, userId }),
        // Several web searches plus the model's answer; usually well under this.
        signal: AbortSignal.timeout(150_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      listings = ((await res.json()) as { listings: ProductListing[] }).listings;
    } catch (error) {
      console.error("[productSearch] Search failed:", error instanceof Error ? error.message : String(error));
      await ctx.runMutation(internal.productSearch.refund, { userId, day });
      throw new ConvexError("The search didn't work. It hasn't counted toward today's limit.");
    }

    if (listings.length === 0) await ctx.runMutation(internal.productSearch.refund, { userId, day });
    return listings;
  },
});
