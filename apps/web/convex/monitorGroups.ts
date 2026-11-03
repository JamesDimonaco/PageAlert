import { ConvexError, v, type Infer } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isSearchRegion } from "@prowl/shared";
import { hasBetaFeature } from "./betaFeatures";
import { createMonitorForUser, validateAlertOn } from "./monitors";
import { validateMonitorUrl } from "./shared";
import {
  alertOnValidator,
  checkIntervalValidator,
  groupListingValidator,
  listingLabelValidator,
  notificationChannelsValidator,
} from "./schema";

/** One search returns at most 8, so a product starts with no more than that. */
const MAX_LISTINGS = 8;
const MAX_NAME_LENGTH = 200;
const MAX_SITE_LENGTH = 100;

type AlertOn = Infer<typeof alertOnValidator>;
type GroupListing = Infer<typeof groupListingValidator>;

/** A listing's monitor prompt. A template rather than an AI call: the criteria are already structured. */
export function productPrompt(title: string, alertOn: AlertOn): string {
  const price = alertOn.priceDrop === true || alertOn.priceBelow !== undefined;
  const what = alertOn.backInStock === true && price ? "price and stock" : price ? "price" : "stock";
  return `Track this product's ${what}: ${title}`;
}

function isWatchableUrl(url: string): boolean {
  try {
    validateMonitorUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a product from a search: one monitor per ticked listing, each with
 * the product's criteria, channels and interval. Unticked listings are kept
 * as suggestions. All or nothing: if any monitor can't be created (the plan's
 * monitor limit, the creation rate limit, a bad link) nothing is.
 */
export const create = mutation({
  args: {
    name: v.string(),
    region: v.string(),
    alertOn: alertOnValidator,
    notificationChannels: notificationChannelsValidator,
    checkInterval: checkIntervalValidator,
    listings: v.array(
      v.object({
        site: v.string(),
        url: v.string(),
        title: v.string(),
        price: v.optional(v.number()),
        currency: v.optional(v.string()),
        inStock: v.optional(v.boolean()),
        label: listingLabelValidator,
        watch: v.boolean(),
      })
    ),
  },
  handler: async (ctx, args): Promise<{ groupId: Id<"monitorGroups">; monitorIds: Id<"monitors">[] }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Sign in to watch a product.");
    const userId = identity.subject;
    if (!(await hasBetaFeature(ctx, userId, "find_a_product"))) {
      throw new ConvexError("Find a product is a beta feature. Turn it on in Settings.");
    }

    const name = args.name.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) throw new ConvexError("Give the product a name.");
    if (!isSearchRegion(args.region)) throw new ConvexError("Pick a country to search.");
    if (args.listings.length > MAX_LISTINGS) throw new ConvexError(`A product starts with at most ${MAX_LISTINGS} listings.`);
    validateAlertOn(args.alertOn);
    const { backInStock, priceDrop, priceBelow } = args.alertOn;
    if (!backInStock && !priceDrop && priceBelow === undefined) {
      throw new ConvexError("Pick what to be alerted about.");
    }

    const seen = new Set<string>();
    const listings: (GroupListing & { watch: boolean })[] = [];
    for (const { watch, ...listing } of args.listings) {
      const url = listing.url.trim();
      if (seen.has(url)) continue;
      // A suggestion with a link we could never watch is no use later either.
      if (!isWatchableUrl(url)) {
        if (watch) throw new ConvexError(`We can't watch the link from ${listing.site}.`);
        continue;
      }
      seen.add(url);
      listings.push({
        ...listing,
        url,
        site: listing.site.slice(0, MAX_SITE_LENGTH),
        title: listing.title.trim().slice(0, MAX_NAME_LENGTH) || name,
        state: watch ? "watching" : "suggested",
        watch,
      });
    }
    if (!listings.some((l) => l.watch)) throw new ConvexError("Tick at least one listing to watch.");

    const now = Date.now();
    const groupId = await ctx.db.insert("monitorGroups", {
      userId,
      name,
      region: args.region,
      alertOn: args.alertOn,
      notificationChannels: args.notificationChannels,
      checkInterval: args.checkInterval,
      listings: [],
      createdAt: now,
      updatedAt: now,
    });

    const stored: GroupListing[] = [];
    const monitorIds: Id<"monitors">[] = [];
    for (const { watch, ...listing } of listings) {
      if (!watch) {
        stored.push(listing);
        continue;
      }
      let monitorId: Id<"monitors">;
      try {
        monitorId = await createMonitorForUser(
          ctx,
          { userId, userEmail: identity.email ?? undefined },
          {
            name: listing.title,
            url: listing.url,
            prompt: productPrompt(listing.title, args.alertOn),
            checkInterval: args.checkInterval,
            notificationChannels: args.notificationChannels,
          }
        );
      } catch (error) {
        // A plain Error reaches a production client as "Server Error". The
        // throw also rolls back the product and every monitor made so far.
        if (error instanceof ConvexError) throw error;
        throw new ConvexError(error instanceof Error ? error.message : "We couldn't watch those listings.");
      }
      // Active with no schema is what the scheduler reads as "do the first
      // extract", so the first scan runs on the server within a minute and
      // the user can leave. A "scanning" monitor waits on the browser.
      await ctx.db.patch(monitorId, { groupId, alertOn: args.alertOn, status: "active", nextCheckAt: now });
      monitorIds.push(monitorId);
      stored.push({ ...listing, monitorId });
    }

    // The plan may have slowed the interval down. Store what the monitors got.
    const first = await ctx.db.get(monitorIds[0]!);
    await ctx.db.patch(groupId, { listings: stored, checkInterval: first?.checkInterval ?? args.checkInterval });
    return { groupId, monitorIds };
  },
});

type MonitorProgress = Pick<Doc<"monitors">, "status" | "checkCount" | "retryCount" | "lastError" | "lastCheckedAt">;

/** A product the signed-in user owns, with the state of each watched listing's monitor. */
export const get = query({
  args: { id: v.id("monitorGroups") },
  handler: async (ctx, { id }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const group = await ctx.db.get(id);
    if (!group || group.userId !== identity.subject) return null;
    const listings = await Promise.all(
      group.listings.map(async (listing) => {
        const monitor = listing.monitorId ? await ctx.db.get(listing.monitorId) : null;
        const progress: MonitorProgress | null = monitor
          ? {
              status: monitor.status,
              checkCount: monitor.checkCount,
              retryCount: monitor.retryCount,
              lastError: monitor.lastError,
              lastCheckedAt: monitor.lastCheckedAt,
            }
          : null;
        return { ...listing, monitor: progress };
      })
    );
    return { ...group, listings };
  },
});
