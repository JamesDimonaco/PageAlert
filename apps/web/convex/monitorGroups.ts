import { ConvexError, v, type Infer, type ObjectType } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { canonicalUrl, isSearchRegion, SEARCH_REGIONS } from "@prowl/shared";
import {
  allowedChannels,
  clampInterval,
  createMonitorForUser,
  readPlan,
  removeMonitorsForUser,
  updateMonitorForUser,
  validateAlertOn,
} from "./monitors";
import { ERROR_ALERT_COOLDOWN_MS, validateMonitorUrl } from "./shared";
import {
  alertOnValidator,
  type AlertOn,
  checkIntervalValidator,
  groupListingValidator,
  listingLabelValidator,
  notificationChannelsValidator,
} from "./schema";

/** One search returns at most 8, so a product starts with no more than that. */
const MAX_LISTINGS = 8;
/** "Find more listings" adds to a product up to this many, dismissed ones included. */
const MAX_PRODUCT_LISTINGS = 24;
const MAX_NAME_LENGTH = 200;
const MAX_SITE_LENGTH = 100;

type GroupListing = Infer<typeof groupListingValidator>;

/** A listing's monitor prompt. A template rather than an AI call: the criteria are already structured. */
export function productPrompt(title: string, alertOn: AlertOn): string {
  const price = alertOn.priceDrop === true || alertOn.priceBelow !== undefined;
  const what = alertOn.backInStock === true && price ? "price and stock" : price ? "price" : "stock";
  return `Track this product's ${what}: ${title}`;
}

/** Checks a product's criteria: one price choice at most, and something to be alerted about. */
function requireCriteria(alertOn: AlertOn): void {
  validateAlertOn(alertOn);
  if (!alertOn.backInStock && !alertOn.priceDrop && alertOn.priceBelow === undefined) {
    throw new ConvexError("Pick what to be alerted about.");
  }
}

type GroupCriteria = Pick<Doc<"monitorGroups">, "_id" | "alertOn" | "notificationChannels" | "checkInterval">;

/** A monitor for one listing, with the product's criteria, first-scanned on the server. */
async function watchListingMonitor(
  ctx: MutationCtx,
  user: { userId: string; userEmail: string | undefined },
  group: GroupCriteria,
  listing: GroupListing
): Promise<Id<"monitors">> {
  const monitorId = await createMonitorForUser(ctx, user, {
    name: listing.title,
    url: listing.url,
    prompt: productPrompt(listing.title, group.alertOn),
    checkInterval: group.checkInterval,
    notificationChannels: group.notificationChannels,
    groupId: group._id,
  });
  // Active with no schema is what the scheduler reads as "do the first
  // extract", so the first scan runs on the server within a minute and
  // the user can leave. A "scanning" monitor waits on the browser.
  await ctx.db.patch(monitorId, {
    alertOn: group.alertOn,
    productTitle: listing.title,
    status: "active",
    nextCheckAt: Date.now(),
  });
  return monitorId;
}

function isWatchableUrl(url: string): boolean {
  try {
    validateMonitorUrl(url);
    return true;
  } catch {
    return false;
  }
}

/** A listing as a search found it, before it has a state in a product. */
const foundListingValidator = v.object({
  site: v.string(),
  url: v.string(),
  title: v.string(),
  price: v.optional(v.number()),
  currency: v.optional(v.string()),
  inStock: v.optional(v.boolean()),
  label: listingLabelValidator,
});
type FoundListing = Infer<typeof foundListingValidator>;

/**
 * A found listing trimmed to fit, or null when its link could never be
 * watched: a suggestion like that is no use later either. A price that is not
 * whole minor units is dropped, because the product card would show it as one.
 */
function cleanListing(listing: FoundListing, fallbackTitle: string): FoundListing | null {
  const url = listing.url.trim();
  if (!isWatchableUrl(url)) return null;
  const { price, ...rest } = listing;
  const validPrice = price !== undefined && Number.isInteger(price) && price >= 0;
  return {
    ...rest,
    ...(validPrice ? { price } : {}),
    url,
    site: listing.site.slice(0, MAX_SITE_LENGTH),
    title: listing.title.trim().slice(0, MAX_NAME_LENGTH) || fallbackTitle,
  };
}

/**
 * Create a product from a search: one monitor per ticked listing, each with
 * the product's criteria, channels and interval. Unticked listings are kept
 * as suggestions. All or nothing: if any monitor can't be created (the plan's
 * monitor limit, the creation rate limit, a bad link) nothing is.
 */
const createArgs = {
  name: v.string(),
  region: v.string(),
  alertOn: alertOnValidator,
  notificationChannels: notificationChannelsValidator,
  checkInterval: checkIntervalValidator,
  listings: v.array(v.object({ ...foundListingValidator.fields, watch: v.boolean() })),
};

export const create = mutation({
  args: createArgs,
  handler: async (ctx, args): Promise<{ groupId: Id<"monitorGroups">; monitorIds: Id<"monitors">[] }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Sign in to watch a product.");
    return createProductForUser(ctx, { userId: identity.subject, userEmail: identity.email ?? undefined }, args);
  },
});

/**
 * Create a product for this user. The web app passes what it found by search;
 * the MCP passes the shop pages an agent picked. No channels means every
 * channel, as for a monitor.
 */
export async function createProductForUser(
  ctx: MutationCtx,
  user: { userId: string; userEmail: string | undefined },
  args: Omit<ObjectType<typeof createArgs>, "notificationChannels"> & {
    notificationChannels: ObjectType<typeof createArgs>["notificationChannels"] | undefined;
  }
): Promise<{ groupId: Id<"monitorGroups">; monitorIds: Id<"monitors">[] }> {
  const { userId } = user;
  const name = args.name.trim().slice(0, MAX_NAME_LENGTH);
  if (!name) throw new ConvexError("Give the product a name.");
  if (!isSearchRegion(args.region)) throw new ConvexError("Pick a country to search.");
  if (args.listings.length > MAX_LISTINGS) throw new ConvexError(`A product starts with at most ${MAX_LISTINGS} listings.`);
  requireCriteria(args.alertOn);

  const seen = new Set<string>();
  const listings: (GroupListing & { watch: boolean })[] = [];
  for (const { watch, ...found } of args.listings) {
    const listing = cleanListing(found, name);
    if (!listing) {
      if (watch) throw new ConvexError(`We can't watch the link from ${found.site}.`);
      continue;
    }
    // Compared the way addSuggestions compares, so both agree on what a repeat is.
    const key = canonicalUrl(listing.url);
    if (seen.has(key)) continue;
    seen.add(key);
    listings.push({ ...listing, state: watch ? "watching" : "suggested", watch });
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
    // A throw rolls back the product and every monitor made so far.
    const monitorId = await watchListingMonitor(
      ctx,
      user,
      { _id: groupId, alertOn: args.alertOn, notificationChannels: args.notificationChannels, checkInterval: args.checkInterval },
      listing
    );
    monitorIds.push(monitorId);
    stored.push({ ...listing, monitorId });
  }

  // The plan may have slowed the interval or dropped channels, the same for
  // every listing. Store what the monitors got.
  const first = await ctx.db.get(monitorIds[0]!);
  await ctx.db.patch(groupId, {
    listings: stored,
    checkInterval: first?.checkInterval ?? args.checkInterval,
    notificationChannels: first?.notificationChannels ?? args.notificationChannels,
  });
  return { groupId, monitorIds };
}

type MonitorProgress = Pick<
  Doc<"monitors">,
  "status" | "checkCount" | "retryCount" | "lastError" | "lastCheckedAt" | "lastSeen"
>;

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
              lastSeen: monitor.lastSeen,
            }
          : null;
        return { ...listing, monitor: progress };
      })
    );
    return { ...group, listings };
  },
});

async function ownedGroup(ctx: MutationCtx, id: Id<"monitorGroups">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Sign in to manage your products.");
  const group = await ctx.db.get(id);
  if (!group || group.userId !== identity.subject) throw new ConvexError("Product not found.");
  return { userId: identity.subject, userEmail: identity.email ?? undefined, group };
}

/** Bounded by the product's listings, one monitor each at most. */
function groupMonitors(ctx: MutationCtx, groupId: Id<"monitorGroups">) {
  return ctx.db
    .query("monitors")
    .withIndex("by_groupId", (q) => q.eq("groupId", groupId))
    .collect();
}

function findListing(group: Doc<"monitorGroups">, url: string, state: GroupListing["state"]): GroupListing {
  const listing = group.listings.find((l) => l.url === url);
  if (!listing || listing.state !== state) throw new ConvexError("That listing has changed. Reload the page.");
  return listing;
}

/**
 * Save a product's criteria, channels and interval, and copy them to every
 * monitor in it, prompt included. A monitor edited on its own page is
 * overwritten. Returns the channels and interval the plan allowed, which can
 * be fewer or slower than asked.
 */
export const updateCriteria = mutation({
  args: {
    id: v.id("monitorGroups"),
    alertOn: alertOnValidator,
    notificationChannels: notificationChannelsValidator,
    checkInterval: checkIntervalValidator,
  },
  handler: async (ctx, args) => {
    const { userId, group } = await ownedGroup(ctx, args.id);
    requireCriteria(args.alertOn);
    const plan = await readPlan(ctx, userId);
    const checkInterval = clampInterval(args.checkInterval, plan.tier);
    const notificationChannels = allowedChannels(plan, args.notificationChannels);
    const monitors = await groupMonitors(ctx, group._id);
    for (const m of monitors) {
      const prompt = productPrompt(m.productTitle ?? m.name, args.alertOn);
      await updateMonitorForUser(
        ctx,
        userId,
        m._id,
        {
          alertOn: args.alertOn,
          notificationChannels,
          // Each is sent only when it changes: a new interval reschedules the
          // check and resets its retries, and a new prompt re-arms error emails.
          ...(m.checkInterval !== checkInterval ? { checkInterval } : {}),
          ...(m.prompt !== prompt ? { prompt } : {}),
        },
        plan
      );
    }
    await ctx.db.patch(group._id, {
      alertOn: args.alertOn,
      checkInterval,
      notificationChannels,
      updatedAt: Date.now(),
    });
    return { checkInterval, notificationChannels };
  },
});

/**
 * Watch a suggested listing. The plan's monitor limit and the creation rate
 * limit apply. Returns the channels and interval the plan allowed it, which
 * the product itself does not take on.
 */
export const watchListing = mutation({
  args: { id: v.id("monitorGroups"), url: v.string() },
  handler: async (ctx, { id, url }) => {
    const { userId, userEmail, group } = await ownedGroup(ctx, id);
    const listing = findListing(group, url, "suggested");
    const monitorId = await watchListingMonitor(ctx, { userId, userEmail }, group, listing);
    const monitor = await ctx.db.get(monitorId);
    // The product keeps its own settings. Taking one new monitor's clamp
    // would change what the product's form shows and saves for every listing.
    await ctx.db.patch(group._id, {
      listings: group.listings.map((l) => (l.url === url ? { ...l, state: "watching" as const, monitorId } : l)),
      updatedAt: Date.now(),
    });
    return {
      monitorId,
      checkInterval: monitor?.checkInterval ?? group.checkInterval,
      notificationChannels: monitor?.notificationChannels ?? group.notificationChannels,
    };
  },
});

/** Stop watching a listing: delete its monitor, which puts the listing back to a suggestion. */
export const unwatchListing = mutation({
  args: { id: v.id("monitorGroups"), url: v.string() },
  handler: async (ctx, { id, url }) => {
    const { userId, group } = await ownedGroup(ctx, id);
    const { monitorId } = findListing(group, url, "watching");
    if (!monitorId) throw new ConvexError("That listing has changed. Reload the page.");
    await removeMonitorsForUser(ctx, userId, [monitorId]);
  },
});

/** Hide a suggested listing, or bring a hidden one back as a suggestion. */
export const setListingDismissed = mutation({
  args: { id: v.id("monitorGroups"), url: v.string(), dismissed: v.boolean() },
  handler: async (ctx, { id, url, dismissed }) => {
    const { group } = await ownedGroup(ctx, id);
    findListing(group, url, dismissed ? "suggested" : "dismissed");
    const state = dismissed ? ("dismissed" as const) : ("suggested" as const);
    await ctx.db.patch(group._id, {
      listings: group.listings.map((l) => (l.url === url ? { ...l, state } : l)),
      updatedAt: Date.now(),
    });
  },
});

/**
 * Pause or resume every monitor in a product, the same way as one at a time.
 * Returns how many changed.
 */
export const setPaused = mutation({
  args: { id: v.id("monitorGroups"), paused: v.boolean() },
  handler: async (ctx, { id, paused }) => {
    const { userId, group } = await ownedGroup(ctx, id);
    const plan = await readPlan(ctx, userId);
    let changed = 0;
    for (const m of await groupMonitors(ctx, group._id)) {
      if ((m.status === "paused") === paused) continue;
      await updateMonitorForUser(ctx, userId, m._id, { status: paused ? "paused" : "active" }, plan);
      changed++;
    }
    return changed;
  },
});

/**
 * Claim the product's one error alert for the cooldown. Null if another
 * listing already sent it, or the product is gone. Otherwise its name.
 * "Checks stopped" alerts are not claimed here: each one is final, so every
 * parked listing sends its own.
 */
export const claimErrorAlert = internalMutation({
  args: { id: v.id("monitorGroups") },
  handler: async (ctx, { id }): Promise<string | null> => {
    const group = await ctx.db.get(id);
    if (!group) return null;
    const now = Date.now();
    if (now - (group.lastErrorAlertAt ?? 0) < ERROR_ALERT_COOLDOWN_MS) return null;
    await ctx.db.patch(id, { lastErrorAlertAt: now });
    return group.name;
  },
});

/** Delete a product and every monitor in it. */
export const remove = mutation({
  args: { id: v.id("monitorGroups") },
  handler: async (ctx, { id }) => {
    const { userId, group } = await ownedGroup(ctx, id);
    const monitors = await groupMonitors(ctx, group._id);
    // First, so deleting each monitor has no listing left to put back.
    await ctx.db.delete(group._id);
    await removeMonitorsForUser(
      ctx,
      userId,
      monitors.map((m) => m._id)
    );
  },
});

/** A product's name, for naming it in an alert. Null when it is gone. */
export const nameOf = internalQuery({
  args: { id: v.id("monitorGroups") },
  handler: async (ctx, { id }): Promise<string | null> => (await ctx.db.get(id))?.name ?? null,
});

async function ownedBy(ctx: QueryCtx, userId: string, id: Id<"monitorGroups">) {
  const group = await ctx.db.get(id);
  return group && group.userId === userId ? group : null;
}

/** What "Find more listings" searches for. Refuses a product the user doesn't own or that is full. */
export const searchTarget = internalQuery({
  args: { userId: v.string(), id: v.id("monitorGroups") },
  handler: async (ctx, { userId, id }) => {
    const group = await ownedBy(ctx, userId, id);
    if (!group) throw new ConvexError("Product not found.");
    if (group.listings.length >= MAX_PRODUCT_LISTINGS) {
      throw new ConvexError(
        `This product already has ${MAX_PRODUCT_LISTINGS} listings, the most it can hold. Dismissed ones count too.`
      );
    }
    return { name: group.name, region: group.region };
  },
});

/**
 * Add a search's results to a product as suggestions. Skips any whose link is
 * already in it, in any state, compared as canonical URLs so tracking
 * parameters don't make a repeat look new. Accessories are not stored, the
 * same as ones never revealed when a product is created. Stops at the cap;
 * `full` says some new ones didn't fit. Null when the product is gone. Never
 * throws for either, because the search has already been counted.
 */
export const addSuggestions = internalMutation({
  args: { userId: v.string(), id: v.id("monitorGroups"), listings: v.array(foundListingValidator) },
  handler: async (ctx, { userId, id, listings }): Promise<{ added: string[]; full: boolean } | null> => {
    const group = await ownedBy(ctx, userId, id);
    if (!group) return null;
    const seen = new Set(group.listings.map((l) => canonicalUrl(l.url)));
    const added: GroupListing[] = [];
    let full = false;
    for (const found of listings) {
      if (found.label === "accessory") continue;
      const listing = cleanListing(found, group.name);
      if (!listing || seen.has(canonicalUrl(listing.url))) continue;
      if (group.listings.length + added.length >= MAX_PRODUCT_LISTINGS) {
        full = true;
        break;
      }
      seen.add(canonicalUrl(listing.url));
      added.push({ ...listing, state: "suggested" });
    }
    if (added.length > 0) {
      await ctx.db.patch(group._id, { listings: [...group.listings, ...added], updatedAt: Date.now() });
    }
    return { added: added.map((l) => l.url), full };
  },
});

type Price = { price: number; currency: string; site: string };

export type ProductSummary = {
  _id: Id<"monitorGroups">;
  name: string;
  watching: number;
  /** Null when no listing has a price yet. */
  cheapest: Price | null;
  /** True if any listing is in stock, false if every known one is out, null if none is known. */
  inStock: boolean | null;
  lastCheckedAt?: number;
  paused: number;
  errored: number;
};

/**
 * The signed-in user's products, each summed up from its watched listings'
 * monitors for the dashboard card. A monitor's last read wins over the price
 * and stock the search found.
 */
export const listMine = query({
  args: {},
  handler: async (ctx): Promise<ProductSummary[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const groups = await ctx.db
      .query("monitorGroups")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .collect();
    return Promise.all(
      groups.map(async (group) => {
        const rows = await Promise.all(
          group.listings.map(async (listing) => {
            const monitor = listing.monitorId ? await ctx.db.get(listing.monitorId) : null;
            return monitor ? [{ listing, monitor }] : [];
          })
        );
        const watched = rows.flat();

        const prices: Price[] = watched.flatMap(({ listing, monitor }) => {
          const seen = monitor.lastSeen;
          if (seen?.price !== undefined && seen.currency) return [{ price: seen.price, currency: seen.currency, site: listing.site }];
          if (listing.price !== undefined && listing.currency) return [{ price: listing.price, currency: listing.currency, site: listing.site }];
          return [];
        });
        // Prices in two currencies can't be compared. A product is searched in
        // one region, so a different currency is the odd one out: take the
        // cheapest in the most common one. On a tie, the region's own
        // currency wins, then the first code alphabetically.
        const home = SEARCH_REGIONS.find((r) => r.code === group.region)?.currency;
        const counts = new Map<string, number>();
        for (const p of prices) counts.set(p.currency, (counts.get(p.currency) ?? 0) + 1);
        const currency = [...counts]
          .sort(([a, n], [b, m]) => m - n || (a === home ? -1 : b === home ? 1 : a.localeCompare(b)))[0]?.[0];
        const cheapest = prices
          .filter((p) => p.currency === currency)
          .reduce<Price | null>((best, p) => (best === null || p.price < best.price ? p : best), null);

        const stock = watched.flatMap(({ listing, monitor }) => {
          const inStock = monitor.lastSeen?.inStock ?? listing.inStock;
          return inStock === undefined ? [] : [inStock];
        });
        const checked = watched.flatMap(({ monitor }) => (monitor.lastCheckedAt ? [monitor.lastCheckedAt] : []));

        return {
          _id: group._id,
          name: group.name,
          watching: watched.length,
          cheapest,
          inStock: stock.length === 0 ? null : stock.includes(true),
          lastCheckedAt: checked.length > 0 ? Math.max(...checked) : undefined,
          paused: watched.filter(({ monitor }) => monitor.status === "paused").length,
          errored: watched.filter(({ monitor }) => monitor.status === "error").length,
        };
      })
    );
  },
});
