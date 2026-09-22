import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  cancellationAction,
  isStaleSubscriptionEvent,
  productTier,
  preferSubscription,
  reconcileAction,
  tierAlert,
  TIER_RANK,
  type TierChange,
} from "@prowl/shared";

/**
 * The tiers, cheapest first. "sprint" is the 30-day pass: a one-off Polar
 * order rather than a subscription, held as a grant and reverted by
 * expireGrants like any other. See grantPass below.
 */
export type Tier = "free" | "sprint" | "pro" | "max";

export const tierValidator = v.union(
  v.literal("free"),
  v.literal("sprint"),
  v.literal("pro"),
  v.literal("max")
);

/** Ordering for "don't downgrade someone who already has more" comparisons. */
export { TIER_RANK } from "@prowl/shared";

/** The tier a user is actually on right now: "free" once a grant has lapsed, else the stored tier. */
export function effectiveTier(
  record: { tier: Tier; grantUntil?: number } | null | undefined,
  now = Date.now(),
): Tier {
  if (!record) return "free";
  if (record.grantUntil && record.grantUntil <= now) return "free";
  return record.tier;
}

/** Get the current user's tier and cancellation status */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { tier: "free" as const, isCancelled: false, periodEnd: null, grantUntil: null, grantSource: null };
    }

    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();

    const now = Date.now();
    const grantLapsed = !!record?.grantUntil && record.grantUntil <= now;

    return {
      tier: effectiveTier(record, now),
      isCancelled: !!record?.cancelledAt,
      periodEnd: record?.periodEnd ?? null,
      grantUntil: grantLapsed ? null : (record?.grantUntil ?? null),
      grantSource: grantLapsed ? null : (record?.grantSource ?? null),
    };
  },
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Apply a paid one-off pass. Polar sends these as orders, not subscriptions,
 * so there is nothing to renew or cancel — the pass is a grant with an expiry
 * and the existing expireGrants cron reverts it.
 *
 * grantSource tells a bought pass apart from an admin trial, which the billing
 * UI words differently and which isPayingRecord treats differently.
 */
export const grantPass = internalMutation({
  args: {
    userId: v.string(),
    tier: tierValidator,
    days: v.number(),
    /** Polar order id, so a redelivered webhook is applied once */
    orderId: v.string(),
    polarCustomerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const alreadyApplied = await ctx.db
      .query("appliedOrders")
      .withIndex("by_orderId", (q) => q.eq("orderId", args.orderId))
      .unique();
    if (alreadyApplied) {
      console.log(`[tiers] Order ${args.orderId} already applied, ignoring redelivery`);
      return;
    }

    const existing = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();

    // A pass must never be written onto a live subscription. grantUntil is
    // what makes access expire, so stamping one on a subscriber's row would
    // drop them to free 30 days later — still paying, no webhook coming to
    // put them back. Refuse, loudly, and leave the row alone.
    const hasLiveSubscription =
      !!existing?.polarSubscriptionId &&
      !existing.grantUntil &&
      effectiveTier(existing, now) !== "free";
    if (hasLiveSubscription) {
      console.error(
        `[tiers] Pass purchased by ${args.userId} who already holds subscription ` +
          `${existing!.polarSubscriptionId}. Not applied — refund it.`
      );
      // The one money path that needs a person: they have paid and got
      // nothing, and nothing else in the system will ever mention it.
      await ctx.scheduler.runAfter(0, internal.admin.notify, {
        text: `🚨 REFUND NEEDED: ${args.userId} bought a ${args.tier} pass while holding subscription ${existing!.polarSubscriptionId}. Not applied — order ${args.orderId}.`,
      });
      return;
    }

    // Otherwise never hand someone less than they already have.
    const current = effectiveTier(existing, now);
    const tier = TIER_RANK[current] > TIER_RANK[args.tier] ? current : args.tier;

    // A second pass extends the first rather than restarting it, so buying
    // two in a month buys two months.
    const liveGrant = existing?.grantUntil && existing.grantUntil > now ? existing.grantUntil : now;
    const grantUntil = liveGrant + args.days * DAY_MS;

    const patch = {
      tier,
      grantUntil,
      grantSource: "pass" as const,
      cancelledAt: undefined,
      periodEnd: undefined,
      updatedAt: now,
      ...(args.polarCustomerId != null ? { polarCustomerId: args.polarCustomerId } : {}),
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("userTiers", { userId: args.userId, ...patch });
    }
    await ctx.db.insert("appliedOrders", {
      orderId: args.orderId,
      userId: args.userId,
      appliedAt: now,
    });

    // Scheduled from inside the transaction, so a pass that rolls back cannot
    // announce itself — and the appliedOrders guard above means a redelivered
    // webhook never sends a second one.
    await ctx.scheduler.runAfter(0, internal.admin.notify, {
      text: `💷 Pass bought: ${args.tier} for ${args.days} days (${args.userId})`,
    });
  },
});

/**
 * Tell the operator that money moved, in both directions — hearing only the
 * good news would make the channel useless for knowing where things stand.
 *
 * Which message, and whether to send one at all, is `tierAlert` in
 * @prowl/shared: the combinations are subtle enough to be worth a decision
 * table with tests rather than a chain of conditions here.
 */
async function announce(ctx: MutationCtx, userId: string, change: TierChange) {
  const alert = tierAlert(change);
  const text =
    alert.kind === "none"
      ? null
      : alert.kind === "converted"
        ? `💷 Trial converted: now paying for ${alert.tier} (${userId})`
        : alert.kind === "started"
          ? `💷 New ${alert.tier} subscriber${alert.from === "free" ? "" : ` (was ${alert.from})`} (${userId})`
          : `📉 Subscription ended: ${alert.from} → free (${userId})`;
  if (text) await ctx.scheduler.runAfter(0, internal.admin.notify, { text });
}

/**
 * Alert the operator without letting a Telegram failure become the error.
 * admin.notify does its own fetch with a timeout; thrown from inside a catch
 * it would replace the real cause on the way out.
 */
async function notifyQuietly(ctx: { runAction: (ref: any, args: any) => Promise<unknown> }, text: string) {
  try {
    await ctx.runAction(internal.admin.notify, { text });
  } catch (notifyErr) {
    console.error("[tiers] could not reach Telegram:", notifyErr);
  }
}

/** Row-shaped adapter for the tested predicate in @prowl/shared. */
function staleEvent(
  existing: { polarSubscriptionId?: string; subscriptionModifiedAt?: number } | null,
  args: { polarSubscriptionId?: string; subscriptionModifiedAt?: number },
): boolean {
  return isStaleSubscriptionEvent({
    storedSubscriptionId: existing?.polarSubscriptionId,
    storedModifiedAt: existing?.subscriptionModifiedAt,
    incomingSubscriptionId: args.polarSubscriptionId,
    incomingModifiedAt: args.subscriptionModifiedAt,
  });
}

/** Internal mutation for webhook-triggered tier updates */
export const update = internalMutation({
  args: {
    userId: v.string(),
    tier: tierValidator,
    polarCustomerId: v.optional(v.string()),
    polarSubscriptionId: v.optional(v.string()),
    /** Polar's modified_at, as an ordering key — see isStaleSubscriptionEvent. */
    subscriptionModifiedAt: v.optional(v.number()),
    /** Reconcile sends its own summary, so it suppresses the per-change alert. */
    silent: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();

    if (staleEvent(existing, args)) {
      console.log(`[tiers] update: ignoring stale event for ${args.userId} sub ${args.polarSubscriptionId}`);
      return false;
    }

    if (existing) {
      // A revoke must not wipe a manual grant that outlives the subscription
      // (e.g. a late-delivered webhook for an old sub after an admin trial).
      const keepGrant = args.tier === "free" && !!existing.grantUntil && existing.grantUntil > Date.now();
      const patch: Record<string, unknown> = {
        tier: keepGrant ? existing.tier : args.tier,
        // Clear cancellation, and the manual grant when a real sub replaces it
        cancelledAt: undefined,
        periodEnd: undefined,
        grantUntil: keepGrant ? existing.grantUntil : undefined,
        grantSource: keepGrant ? existing.grantSource : undefined,
        updatedAt: Date.now(),
      };
      if (args.polarCustomerId != null) patch.polarCustomerId = args.polarCustomerId;
      if (args.polarSubscriptionId != null) patch.polarSubscriptionId = args.polarSubscriptionId;
      // The stamp only means anything next to the id it was read from. Writing
      // a new id without one would leave the old subscription's timestamp
      // guarding the new subscription, silently dropping its later events.
      if (args.subscriptionModifiedAt != null) {
        patch.subscriptionModifiedAt = args.subscriptionModifiedAt;
      } else if (args.polarSubscriptionId != null && args.polarSubscriptionId !== existing.polarSubscriptionId) {
        patch.subscriptionModifiedAt = undefined;
      }
      await ctx.db.patch(existing._id, patch);
      const liveGrant = !!existing.grantUntil && existing.grantUntil > Date.now();
      if (!args.silent) await announce(ctx, args.userId, {
        before: effectiveTier(existing, Date.now()),
        after: args.tier,
        keptGrant: keepGrant,
        // Only a grant actually being dropped for a real subscription counts.
        replacedGrant: !keepGrant && liveGrant && args.tier !== "free" ? existing.grantSource : undefined,
      });
    } else {
      const doc: Record<string, unknown> = {
        userId: args.userId,
        tier: args.tier,
        updatedAt: Date.now(),
      };
      if (args.polarCustomerId != null) doc.polarCustomerId = args.polarCustomerId;
      if (args.polarSubscriptionId != null) doc.polarSubscriptionId = args.polarSubscriptionId;
      if (args.subscriptionModifiedAt != null) doc.subscriptionModifiedAt = args.subscriptionModifiedAt;
      await ctx.db.insert("userTiers", doc as any);
      if (!args.silent) await announce(ctx, args.userId, { before: "free", after: args.tier, keptGrant: false });
    }
    return true;
  },
});

/** Internal mutation for marking a subscription as cancelled (still active until period end) */
export const markCancelled = internalMutation({
  args: {
    userId: v.string(),
    periodEnd: v.number(),
    polarSubscriptionId: v.optional(v.string()),
    subscriptionModifiedAt: v.optional(v.number()),
    /** Reconcile sends its own summary, so it suppresses the per-change alert. */
    silent: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();

    if (staleEvent(existing, args)) {
      console.log(`[tiers] markCancelled: ignoring stale event for ${args.userId}`);
      return false;
    }

    if (!existing) {
      console.warn("[tiers] markCancelled: no userTiers record for userId:", args.userId, "sub:", args.polarSubscriptionId);
      return false;
    }

    // Already says exactly this. Returning early keeps cancelledAt meaning
    // "when they cancelled" rather than "when a job last looked", now that
    // reconcile re-asserts cancellations on every run.
    if (existing.cancelledAt && existing.periodEnd === args.periodEnd) return true;

    const patch: Record<string, unknown> = {
      cancelledAt: Date.now(),
      periodEnd: args.periodEnd,
      updatedAt: Date.now(),
    };
    if (args.polarSubscriptionId != null) patch.polarSubscriptionId = args.polarSubscriptionId;
    if (args.subscriptionModifiedAt != null) patch.subscriptionModifiedAt = args.subscriptionModifiedAt;
    await ctx.db.patch(existing._id, patch);

    // Distinct from the revoke above: they still have access until periodEnd,
    // so this is the one with time left to do something about it.
    if (!existing.cancelledAt && !args.silent) {
      const until = new Date(args.periodEnd).toLocaleDateString("en-GB", {
        day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
      });
      await ctx.scheduler.runAfter(0, internal.admin.notify, {
        text: `⚠️ Cancelled: ${effectiveTier(existing)} subscription, access until ${until} (${args.userId})`,
      });
    }
    return true;
  },
});

/**
 * Undo a cancellation the customer has reversed.
 *
 * Nothing used to do this. A customer who resubscribed through the Polar
 * portal kept the amber "your plan has been cancelled" banner, and once the
 * old period end passed, "your access has expired" — while paying.
 */
export const clearCancellation = internalMutation({
  args: {
    userId: v.string(),
    polarSubscriptionId: v.optional(v.string()),
    subscriptionModifiedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (!existing || !existing.cancelledAt) return true;
    if (staleEvent(existing, args)) return false;

    const patch: Record<string, unknown> = {
      cancelledAt: undefined,
      periodEnd: undefined,
      updatedAt: Date.now(),
    };
    if (args.subscriptionModifiedAt != null) patch.subscriptionModifiedAt = args.subscriptionModifiedAt;
    await ctx.db.patch(existing._id, patch);

    await ctx.scheduler.runAfter(0, internal.admin.notify, {
      text: `↩️ Uncancelled: ${effectiveTier(existing)} subscription is staying (${args.userId})`,
    });
    return true;
  },
});

const DAILY_SCAN_LIMITS: Record<Tier, number> = { free: 10, sprint: 40, pro: 100, max: 1000 };

/** Check whether the current user can perform a manual scan */
export const canScan = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { canScan: false, remaining: 0, limit: 0 };
    const userId = identity.subject;

    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    const tier = effectiveTier(record);
    const limit = DAILY_SCAN_LIMITS[tier];

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const used = record?.dailyScansDate === today ? (record?.dailyScans ?? 0) : 0;

    return { canScan: used < limit, remaining: Math.max(0, limit - used), limit };
  },
});

/** Atomically check budget and consume a scan. Returns { success, remaining, limit }. */
export const consumeScan = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = identity.subject;

    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    const tier = effectiveTier(record);
    const limit = DAILY_SCAN_LIMITS[tier];
    const today = new Date().toISOString().slice(0, 10);

    if (record) {
      const isToday = record.dailyScansDate === today;
      const used = isToday ? (record.dailyScans ?? 0) : 0;
      if (used >= limit) {
        return { success: false, remaining: 0, limit };
      }
      await ctx.db.patch(record._id, {
        dailyScans: used + 1,
        dailyScansDate: today,
      } as any);
      return { success: true, remaining: Math.max(0, limit - used - 1), limit };
    } else {
      // No tier record — create one (free tier, first scan)
      if (1 > limit) return { success: false, remaining: 0, limit }; // shouldn't happen, free limit is 10
      await ctx.db.insert("userTiers", {
        userId,
        tier: "free",
        dailyScans: 1,
        dailyScansDate: today,
        updatedAt: Date.now(),
      } as any);
      return { success: true, remaining: limit - 1, limit };
    }
  },
});

/**
 * Polar is the source of truth for what a customer pays; userTiers is a cache
 * of it. This reconciles the cache.
 *
 * It exists because the webhook path can only write on the events it actually
 * receives. A `subscription.created` missed during a deploy — or before the
 * handler shipped at all — left the account on free while Polar went on
 * billing it monthly, and nothing downstream ever noticed: six months, in the
 * case that prompted this. Adding more webhook handlers does not fix that,
 * because the failure is the event never arriving.
 *
 * Deliberately one-directional. It grants what Polar says is paid for, and
 * only reports the opposite case instead of acting on it. Wrongly granting
 * access costs a few pounds; wrongly revoking it takes a paying customer's
 * service away on the strength of an API read that may have been partial.
 * Revocation keeps its two webhook paths and expireGrants.
 */

const POLAR_PAGE = 100;
/** Enough for 2,000 active subscriptions; a real run reads one page. */
const POLAR_MAX_PAGES = 20;

type PolarSubscription = {
  id: string;
  product_id?: string;
  customer_id?: string;
  cancel_at_period_end?: boolean;
  current_period_end?: string | null;
  created_at?: string | null;
  modified_at?: string | null;
  customer?: { external_id?: string | null } | null;
};

async function fetchActiveSubscriptions(token: string, production: boolean): Promise<PolarSubscription[]> {
  const base = production ? "https://api.polar.sh" : "https://sandbox-api.polar.sh";
  const items: PolarSubscription[] = [];

  for (let page = 1; page <= POLAR_MAX_PAGES; page++) {
    const res = await fetch(`${base}/v1/subscriptions/?active=true&limit=${POLAR_PAGE}&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`Polar subscriptions page ${page}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    }
    const body = (await res.json()) as {
      items?: PolarSubscription[];
      pagination?: { max_page?: number };
    };
    items.push(...(body.items ?? []));
    const maxPage = body.pagination?.max_page;
    // Defaulting a missing max_page to 1 would turn a first page into "that is
    // all of them" — the exact partial-read-as-truth this function refuses to
    // return. If Polar stops sending it, that is a failure, not one page.
    if (typeof maxPage !== "number") {
      throw new Error(`Polar subscriptions page ${page}: no pagination.max_page in response`);
    }
    if (page >= maxPage) return items;
  }
  // Falling out of the loop means Polar has more pages than we read, so the
  // result is a subset. Refuse it rather than let the caller treat a partial
  // read as the whole truth.
  throw new Error(`Polar returned more than ${POLAR_MAX_PAGES * POLAR_PAGE} active subscriptions`);
}

/**
 * Current cached state for the handful of users Polar says are subscribed.
 * Indexed per user rather than a full table scan, so this stays bounded by
 * paying customers rather than by signups.
 */
export const cachedStateFor = internalQuery({
  args: { userIds: v.array(v.string()) },
  handler: async (ctx, { userIds }) => {
    const rows = await Promise.all(
      userIds.map((userId) =>
        ctx.db
          .query("userTiers")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .unique(),
      ),
    );
    return rows.map((row, i) => ({
      userId: userIds[i],
      tier: effectiveTier(row),
      subscriptionId: row?.polarSubscriptionId ?? null,
      isCancelled: !!row?.cancelledAt,
      periodEnd: row?.periodEnd ?? null,
    }));
  },
});

/**
 * Every row that names a Polar subscription, so reconcile can spot the ones
 * Polar no longer bills. A full scan, bounded by paying customers rather than
 * signups once the index below is the filter.
 */
export const rowsWithSubscriptions = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("userTiers").collect();
    return rows
      .filter((r) => r.polarSubscriptionId !== undefined && effectiveTier(r) !== "free")
      .map((r) => ({
        userId: r.userId,
        subscriptionId: r.polarSubscriptionId as string,
        tier: effectiveTier(r),
        /** A bought pass or admin trial explains paid access with no live sub. */
        grantSource: r.grantSource ?? null,
      }));
  },
});

export const reconcile = internalAction({
  args: {
    /** Report what would change without writing it. The cron runs live. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun === true;
    const token = process.env.POLAR_ACCESS_TOKEN;
    if (!token) {
      console.warn("[tiers] reconcile: POLAR_ACCESS_TOKEN not set, skipping");
      return;
    }
    const productIds = { pro: process.env.POLAR_PRO_PRODUCT_ID, max: process.env.POLAR_MAX_PRODUCT_ID };
    // Without these every subscription falls through to "unknown product":
    // zero repairs, and a daily message listing every paying customer as
    // broken. Refuse to run rather than look like the drift we hunt.
    if (!productIds.pro || !productIds.max) {
      await notifyQuietly(ctx, "🚨 Billing reconcile skipped: POLAR_PRO_PRODUCT_ID / POLAR_MAX_PRODUCT_ID not set");
      return;
    }

    let subscriptions: PolarSubscription[];
    try {
      subscriptions = await fetchActiveSubscriptions(token, process.env.POLAR_ENVIRONMENT === "production");
    } catch (err) {
      // A reconcile that fails quietly is the bug it was written to catch, so
      // this is the one failure worth interrupting for. notifyQuietly so a
      // Telegram timeout cannot replace the Polar error on its way out.
      await notifyQuietly(ctx, `🚨 Billing reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    const unknownProduct: string[] = [];
    const noExternalId: string[] = [];
    const multipleSubs: string[] = [];

    // One subscription per user, decided before anything is written.
    //
    // Polar's org setting currently forbids a customer holding two at once, so
    // this is a guard rather than a live case — but iterating subscriptions
    // and writing as we go made the row depend on the order the API happened
    // to return them: a max and a cancelling pro could leave the tier on max,
    // the subscription id pointing at pro, and the row marked cancelled.
    // Highest tier wins, then the latest period end, so the choice is the same
    // whatever order they arrive in.
    const byUser = new Map<string, { userId: string; tier: Tier; sub: PolarSubscription }>();

    for (const sub of subscriptions) {
      const userId = sub.customer?.external_id;
      if (!userId) {
        noExternalId.push(sub.id);
        continue;
      }
      const tier = productTier(sub.product_id, productIds);
      if (!tier) {
        unknownProduct.push(`${sub.id} (product ${sub.product_id})`);
        continue;
      }

      const held = byUser.get(userId);
      if (!held) {
        byUser.set(userId, { userId, tier, sub });
        continue;
      }
      // Two active subscriptions is worth a person's attention either way, so
      // say so once, naming the one that won.
      const key = (c: { tier: Tier; sub: PolarSubscription }) => ({
        id: c.sub.id,
        tier: c.tier,
        periodEndMs: c.sub.current_period_end ? Date.parse(c.sub.current_period_end) : 0,
      });
      const candidate = { userId, tier, sub };
      const winner = preferSubscription(key(candidate), key(held)).id === sub.id ? candidate : held;
      byUser.set(userId, winner);
      multipleSubs.push(`${userId}: ${sub.id} and ${held.sub.id}, using ${winner.sub.id}`);
    }

    const wanted = [...byUser.values()];
    const cached = wanted.length
      ? await ctx.runQuery(internal.tiers.cachedStateFor, { userIds: wanted.map((w) => w.userId) })
      : [];
    const cachedByUser = new Map(cached.map((c) => [c.userId, c]));

    const granted: string[] = [];
    const linked: string[] = [];
    const overGranted: string[] = [];
    const cancellations: string[] = [];
    const uncancellations: string[] = [];
    /** Writes the row refused because it already holds a newer event. */
    const raced: string[] = [];
    /** Subscription ids Polar still lists as active, for the orphan pass below. */
    const seenSubscriptionIds = new Set<string>();

    for (const { userId, tier, sub } of wanted) {
      const current = cachedByUser.get(userId);
      const currentTier = current?.tier ?? "free";
      const isLinked = current?.subscriptionId === sub.id;
      let rowRewrittenThisRun = false;
      seenSubscriptionIds.add(sub.id);

      // Live Polar state is by definition current, so it carries the freshest
      // ordering stamp and the mutations' stale-event guard never rejects it.
      // modified_at is null until something changes, hence the created_at
      // fallback — a row with no stamp at all cannot order anything.
      const rawStamp = sub.modified_at ?? sub.created_at;
      const stamped = rawStamp ? Date.parse(rawStamp) : NaN;
      const ordering = Number.isFinite(stamped) ? { subscriptionModifiedAt: stamped } : {};

      const applyTier = async (outcome: string[], label: string) => {
        if (!dryRun) {
          const applied = await ctx.runMutation(internal.tiers.update, {
            userId,
            tier,
            ...(sub.customer_id ? { polarCustomerId: sub.customer_id } : {}),
            polarSubscriptionId: sub.id,
            ...ordering,
            // Reconcile sends one summary below. Letting update() announce as
            // well would report a six-month-old subscription to the operator
            // as a sale made this morning.
            silent: true,
          });
          if (!applied) {
            // The row already holds a newer event than Polar's own record of
            // this subscription. Claiming a repair we did not make is how a
            // reconcile report stops being worth reading.
            raced.push(`${userId}: row is ahead of Polar for sub ${sub.id}`);
            return;
          }
        }
        // update() clears cancelledAt/periodEnd unconditionally, so the
        // cancellation decision below has to know the row was just rewritten
        // rather than trust the snapshot taken before it.
        rowRewrittenThisRun = true;
        outcome.push(label);
      };

      const action = reconcileAction({ cachedTier: currentTier, polarTier: tier, isLinked });
      switch (action) {
        case "grant":
          await applyTier(granted, `${userId}: ${currentTier} → ${tier}`);
          break;
        case "link":
          await applyTier(linked, `${userId}: ${tier} linked to sub ${sub.id}`);
          break;
        case "over-granted":
          overGranted.push(`${userId}: on ${currentTier}, Polar bills ${tier} (sub ${sub.id})`);
          break;
        case "none":
          break;
      }

      // Only for the subscription this row actually reflects. On over-granted
      // we deliberately refused to touch the tier, so writing a cancellation
      // from that same subscription would repoint the row at it anyway — and
      // announce an end date for a tier that is not the one ending.
      if (action === "over-granted") continue;

      const rawEnd = sub.current_period_end ? Date.parse(sub.current_period_end) : NaN;
      const cancellation = cancellationAction({
        polarCancelAtPeriodEnd: sub.cancel_at_period_end === true,
        polarPeriodEndMs: Number.isFinite(rawEnd) ? rawEnd : null,
        rowIsCancelled: !!current?.isCancelled,
        rowPeriodEndMs: current?.periodEnd ?? undefined,
        rowRewrittenThisRun,
      });

      if (cancellation === "mark") {
        const applied =
          dryRun ||
          (await ctx.runMutation(internal.tiers.markCancelled, {
            userId,
            periodEnd: rawEnd,
            polarSubscriptionId: sub.id,
            ...ordering,
            silent: true,
          }));
        if (applied) cancellations.push(`${userId}: access until ${new Date(rawEnd).toISOString().slice(0, 10)}`);
      } else if (cancellation === "clear") {
        const applied =
          dryRun ||
          (await ctx.runMutation(internal.tiers.clearCancellation, {
            userId,
            polarSubscriptionId: sub.id,
            ...ordering,
          }));
        if (applied) uncancellations.push(`${userId}: cancellation reversed`);
      }
    }

    // Rows that still claim a Polar subscription Polar no longer lists as
    // active. A missed subscription.revoked is the same delivery failure as
    // the one this job exists for, just in the direction that costs money
    // rather than goodwill — and nothing else in the system mentions it.
    const orphans = (
      await ctx.runQuery(internal.tiers.rowsWithSubscriptions, {})
    ).filter((row) => !seenSubscriptionIds.has(row.subscriptionId));

    const repaired = [
      ...granted.map((g) => `  granted ${g}`),
      ...linked.map((l) => `  linked ${l}`),
      ...cancellations.map((c) => `  cancelling ${c}`),
      ...uncancellations.map((u) => `  uncancelled ${u}`),
    ];
    // These need a person. They repeat every morning until someone acts,
    // which is the point — nothing else in the system mentions them.
    const needsYou = [
      ...overGranted.map((o) => `  over-granted ${o}`),
      ...raced.map((r) => `  ahead of Polar ${r}`),
      ...orphans.map(
        (o) =>
          `  no live sub ${o.userId}: row says ${o.tier}` +
          `${o.grantSource ? ` (${o.grantSource} grant)` : ", Polar bills nothing"} — sub ${o.subscriptionId}`,
      ),
      ...multipleSubs.map((m) => `  two active subs ${m}`),
      ...unknownProduct.map((u) => `  unknown product ${u}`),
      ...noExternalId.map((n) => `  no external id ${n}`),
    ];

    console.log(
      `[tiers] reconcile${dryRun ? " (dry run)" : ""}: ${subscriptions.length} active sub(s), ` +
        `${repaired.length} repaired, ${needsYou.length} needing attention`,
    );

    // Silent when there is nothing wrong. The daily pulse already proves the
    // crons are alive, so a heartbeat here would only add noise to the channel
    // that has to stay worth reading. The one exception is an empty read:
    // zero active subscriptions while rows still claim paid tiers means the
    // token is pointed at the wrong account, and that looks identical to a
    // clean run otherwise.
    if (subscriptions.length === 0 && orphans.length > 0) {
      await notifyQuietly(
        ctx,
        `🚨 Billing reconcile read 0 active subscriptions from Polar, but ${orphans.length} row(s) still claim one. ` +
          `Check POLAR_ACCESS_TOKEN and POLAR_ENVIRONMENT before trusting this.`,
      );
      return;
    }

    if (repaired.length || needsYou.length) {
      const prefix = dryRun ? "🔁 Billing reconcile (dry run)" : "🔁 Billing reconcile";
      const headline = needsYou.length
        ? `${prefix}: ${dryRun ? "would fix" : "fixed"} ${repaired.length}, ${needsYou.length} need(s) you`
        : `${prefix}: ${dryRun ? "would fix" : "fixed"} ${repaired.length}`;
      await notifyQuietly(ctx, [headline, ...repaired, ...needsYou].join("\n"));
    }
  },
});
