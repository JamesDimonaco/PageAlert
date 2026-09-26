import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireLiveAccount } from "./account";
import {
  cancellationAction,
  isStaleSubscriptionEvent,
  periodEndMs,
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
async function notifyQuietly(ctx: Pick<ActionCtx, "runAction">, text: string) {
  try {
    await ctx.runAction(internal.admin.notify, { text });
  } catch (notifyErr) {
    console.error("[tiers] could not reach Telegram:", notifyErr);
  }
}

/** DMY, the convention for anything a person reads. Storage stays epoch ms. */
function displayDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
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

/**
 * The tier stored on the row, ignoring any grant on top of it.
 *
 * Deliberately not effectiveTier: a live grant can read as max while the
 * subscription row still says pro, and a handler that skips its write on that
 * basis leaves the row to collapse to free when the grant lapses.
 */
export const storedTierFor = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    return row?.tier ?? ("free" as Tier);
  },
});

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

    // A retried event for a subscription the row has since moved off says
    // nothing about the one it holds now. The stale guard cannot catch this —
    // a different id is deliberately a different timeline — so a late
    // `revoked` for a cancelled subscription would drop a customer who has
    // already resubscribed. Raising a tier from a new subscription is fine;
    // lowering one on behalf of a dead subscription is not.
    if (
      existing?.polarSubscriptionId &&
      args.polarSubscriptionId != null &&
      args.polarSubscriptionId !== existing.polarSubscriptionId &&
      // Only a downgrade. A paid tier arriving under a different id is the
      // customer's live subscription — Polar forbids holding two — and
      // refusing it left a genuine subscriber on free whenever an unrelated
      // admin grant happened to outrank the tier they had just bought.
      args.tier === "free"
    ) {
      console.warn(
        `[tiers] update: refusing to lower ${args.userId} to ${args.tier} on behalf of ` +
          `${args.polarSubscriptionId}; row holds ${existing.polarSubscriptionId}`,
      );
      return false;
    }

    if (existing) {
      // A revoke must not wipe a manual grant that outlives the subscription
      // (e.g. a late-delivered webhook for an old sub after an admin trial).
      const keepGrant = args.tier === "free" && !!existing.grantUntil && existing.grantUntil > Date.now();
      // Only a genuinely different subscription, or a tier that actually
      // moved, says anything about the cancellation. Clearing it on every
      // write meant an `active` event for an already-cancelled subscription
      // silently dropped the customer's end date, and forced two separate
      // compensations to put it back.
      const sameSubscription =
        args.polarSubscriptionId != null && args.polarSubscriptionId === existing.polarSubscriptionId;
      const keepCancellation = sameSubscription && args.tier === existing.tier;
      const patch: Record<string, unknown> = {
        tier: keepGrant ? existing.tier : args.tier,
        ...(keepCancellation ? {} : { cancelledAt: undefined, periodEnd: undefined }),
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

    // Same reasoning as clearCancellation's guard: a cancellation belongs to
    // the subscription that raised it, and stamping it onto a row that has
    // moved on tells a paying customer their access is ending.
    if (
      existing?.polarSubscriptionId &&
      args.polarSubscriptionId != null &&
      args.polarSubscriptionId !== existing.polarSubscriptionId
    ) {
      console.warn(
        `[tiers] markCancelled: ${args.userId} holds ${existing.polarSubscriptionId}, ` +
          `cancel is for ${args.polarSubscriptionId} — ignoring`,
      );
      return false;
    }

    if (!existing) {
      console.warn("[tiers] markCancelled: no userTiers record for userId:", args.userId, "sub:", args.polarSubscriptionId);
      return false;
    }

    // Already says exactly this. Returning early keeps cancelledAt meaning
    // "when they cancelled" rather than "when a job last looked", now that
    // reconcile re-asserts cancellations on every run.
    if (existing.cancelledAt && existing.periodEnd === args.periodEnd) {
      // Nothing to change, but the event is still newer than what the row was
      // stamped with. Without recording that, a re-cancel returns early and a
      // delayed `uncanceled` from before it still looks fresh enough to wipe
      // a cancellation the customer has since reinstated.
      if (args.subscriptionModifiedAt != null && args.subscriptionModifiedAt > (existing.subscriptionModifiedAt ?? 0)) {
        await ctx.db.patch(existing._id, { subscriptionModifiedAt: args.subscriptionModifiedAt });
      }
      return "unchanged" as const;
    }

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
    /** Reconcile sends its own summary, so it suppresses the per-change alert. */
    silent: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (!existing || !existing.cancelledAt) return false;
    if (staleEvent(existing, args)) return false;
    // The cancellation on the row belongs to whichever subscription recorded
    // it. An uncancel for a different one says nothing about it, and clearing
    // it anyway would tell a leaving customer their access is staying.
    if (args.polarSubscriptionId != null && existing.polarSubscriptionId !== args.polarSubscriptionId) {
      console.warn(
        `[tiers] clearCancellation: ${args.userId} cancelled under ${existing.polarSubscriptionId}, ` +
          `uncancel is for ${args.polarSubscriptionId} — ignoring`,
      );
      return false;
    }

    const patch: Record<string, unknown> = {
      cancelledAt: undefined,
      periodEnd: undefined,
      updatedAt: Date.now(),
    };
    if (args.subscriptionModifiedAt != null) patch.subscriptionModifiedAt = args.subscriptionModifiedAt;
    await ctx.db.patch(existing._id, patch);

    if (!args.silent) {
      await ctx.scheduler.runAfter(0, internal.admin.notify, {
        text: `↩️ Uncancelled: ${effectiveTier(existing)} subscription is staying (${args.userId})`,
      });
    }
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
    await requireLiveAccount(ctx, userId);

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
      modifiedAt: row?.subscriptionModifiedAt ?? null,
      /** A live time-boxed grant this row holds, which a tier write destroys. */
      liveGrant:
        row?.grantUntil && row.grantUntil > Date.now()
          ? { until: row.grantUntil, source: row.grantSource ?? null }
          : null,
    }));
  },
});

/**
 * Every row that names a Polar subscription, so reconcile can spot the ones
 * Polar no longer bills.
 *
 * A full scan. userTiers has only by_userId, and consumeScan writes a row for
 * every free user who scans, so this grows with signups rather than customers
 * — Convex caps one query at 16,384 documents. The cap below turns outgrowing
 * that into a reported partial pass instead of a throw that would take the
 * whole reconcile down with it.
 */
/** See rowsWithSubscriptions. Well under Convex's 16,384-document query limit. */
const ORPHAN_SCAN_CAP = 8000;

/** Under admin.notify's silent 4,000-character slice, with room for the tail line. */
const MESSAGE_BUDGET = 3800;

export const rowsWithSubscriptions = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("userTiers").take(ORPHAN_SCAN_CAP);
    const linked = rows
      .filter((r) => r.polarSubscriptionId !== undefined && effectiveTier(r) !== "free")
      .map((r) => ({
        userId: r.userId,
        subscriptionId: r.polarSubscriptionId as string,
        tier: effectiveTier(r),
        /** A bought pass or admin trial explains paid access with no live sub. */
        grantSource: r.grantSource ?? null,
      }));
    // Reported from the same read, so the flag cannot describe a different
    // snapshot than the list it belongs to.
    return { rows: linked, truncated: rows.length === ORPHAN_SCAN_CAP };
  },
});

export const reconcile = internalAction({
  args: {
    /** Report what would change without writing it. The cron runs live. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // Dry-run unless the deployment says otherwise, matching how every other
    // write-cron here ships (ONBOARDING_EMAILS_ENABLED, INACTIVITY_PAUSE_ENABLED).
    // There is no CI and Vercel deploys from main, so without an env flag the
    // only way to stop a misbehaving run would be another merge.
    const enabled = process.env.BILLING_RECONCILE_ENABLED === "true";
    const dryRun = args.dryRun === true || !enabled;
    const token = process.env.POLAR_ACCESS_TOKEN;
    if (!token) {
      // Logging alone would make a permanently dead reconcile look exactly
      // like a clean one — the shape of the six-month bug this job exists for.
      await notifyQuietly(ctx, "🚨 Billing reconcile skipped: POLAR_ACCESS_TOKEN not set");
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
    /** Subscription ids Polar still lists as active, for the orphan pass below. */
    const seenSubscriptionIds = new Set<string>();

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
      // Before any filter: a row linked to a subscription we skipped is still
      // linked to something Polar bills, and must not be reported as an orphan
      // alongside the very same id under "unknown product".
      seenSubscriptionIds.add(sub.id);
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
    // update() clears a time-boxed grant when a real subscription replaces it
    // — necessary, because grantUntil is what makes access expire and leaving
    // it on a subscriber drops them to free when it passes. But a bought pass
    // is time the customer paid for, and losing it silently in a background
    // job is not something to find out from a support email.
    const grantsReplaced: string[] = [];
    /** Users this run already accounted for, so they are not also called orphans. */
    const handledUsers = new Set<string>();

    for (const { userId, tier, sub } of wanted) {
      const current = cachedByUser.get(userId);
      const currentTier = current?.tier ?? "free";
      const isLinked = current?.subscriptionId === sub.id;
      let rowRewrittenThisRun = false;

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
            // Backstop: the pre-loop snapshot said this was writable and the
            // mutation disagreed, so something changed underneath us. Claiming
            // a repair we did not make is how a report stops being read.
            raced.push(`${userId}: write refused for sub ${sub.id} (changed underneath the run)`);
            return;
          }
        }
        // update() clears cancelledAt/periodEnd when the subscription or tier
        // actually changes, so the cancellation decision below has to know the
        // row was just rewritten rather than trust the earlier snapshot.
        // Only a real write clears the cancellation, so only a real write can
        // make the re-mark below a genuine repair. Setting this in a dry run
        // inflated "would fix" past what a live run actually does — and that
        // number is what the decision to enable this rests on.
        if (!dryRun) rowRewrittenThisRun = true;
        outcome.push(label);
        if (current?.liveGrant) {
          grantsReplaced.push(
            `${userId}: ${current.liveGrant.source ?? "unknown"} grant to ` +
              `${displayDate(current.liveGrant.until)} replaced by ${tier} subscription`,
          );
        }
      };

      // A dry run never calls the mutations, so it cannot learn from them that
      // the row already holds a newer event. Asking the same question here
      // keeps "would fix N" honest about what a live run would actually do.
      if (
        isStaleSubscriptionEvent({
          storedSubscriptionId: current?.subscriptionId ?? undefined,
          storedModifiedAt: current?.modifiedAt ?? undefined,
          incomingSubscriptionId: sub.id,
          incomingModifiedAt: ordering.subscriptionModifiedAt,
        })
      ) {
        raced.push(`${userId}: row is ahead of Polar for sub ${sub.id}`);
        handledUsers.add(userId);
        continue;
      }

      const action = reconcileAction({ cachedTier: currentTier, polarTier: tier, isLinked });
      handledUsers.add(userId);

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

      const rawEnd = periodEndMs(sub.current_period_end);
      const cancellation = cancellationAction({
        polarCancelAtPeriodEnd: sub.cancel_at_period_end === true,
        polarPeriodEndMs: rawEnd,
        rowIsCancelled: !!current?.isCancelled,
        rowPeriodEndMs: current?.periodEnd ?? undefined,
        rowRewrittenThisRun,
      });

      if (cancellation === "mark") {
        const result = dryRun
          ? true
          : await ctx.runMutation(internal.tiers.markCancelled, {
              userId,
              periodEnd: rawEnd as number,
              polarSubscriptionId: sub.id,
              ...ordering,
              silent: true,
            });
        // "unchanged" means the row already said exactly this. Counting it
        // would put a repair in the report that no one made.
        if (result === true) cancellations.push(`${userId}: access until ${displayDate(rawEnd as number)}`);
      } else if (cancellation === "clear") {
        const applied =
          dryRun ||
          (await ctx.runMutation(internal.tiers.clearCancellation, {
            userId,
            polarSubscriptionId: sub.id,
            ...ordering,
            silent: true,
          }));
        if (applied) uncancellations.push(`${userId}: cancellation reversed`);
      }
    }

    // Rows that still claim a Polar subscription Polar no longer lists as
    // active. A missed subscription.revoked is the same delivery failure as
    // the one this job exists for, just in the direction that costs money
    // rather than goodwill — and nothing else in the system mentions it.
    const { rows: allLinkedRows, truncated: orphanScanCapped } = await ctx.runQuery(
      internal.tiers.rowsWithSubscriptions,
      {},
    );
    const orphans = allLinkedRows.filter(
      (row) =>
        !seenSubscriptionIds.has(row.subscriptionId) &&
        // Already accounted for above — reporting the same row as both "linked"
        // and "Polar bills nothing" describes one problem twice.
        !handledUsers.has(row.userId) &&
        // A pass or admin trial explains the paid tier, and expireGrants ends
        // it. Without this the row is listed every morning until it lapses,
        // with nothing anyone can do about it.
        row.grantSource === null,
    );

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
      ...grantsReplaced.map((g) => `  grant replaced ${g}`),
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
      `[tiers] reconcile${dryRun ? (enabled ? " (dry run)" : " (dry run — BILLING_RECONCILE_ENABLED not set)") : ""}: ${subscriptions.length} active sub(s), ` +
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
      // admin.notify slices at 4,000 characters without saying so, and the
      // lines it would cut are the ones appended last — including the warning
      // that the list is already partial. Say what was left out instead.
      // The partial-list warning goes first, not last: the budget loop below
      // drops the tail, which is exactly when the reader most needs to know
      // the list is a sample.
      const lines = [
        headline,
        ...(orphanScanCapped ? [`  ⚠️ orphan scan hit its ${ORPHAN_SCAN_CAP}-row cap — this list is partial`] : []),
        ...repaired,
        ...needsYou,
      ];
      const shown: string[] = [];
      let budget = MESSAGE_BUDGET;
      for (const line of lines) {
        if (budget - line.length - 1 < 0) break;
        budget -= line.length + 1;
        shown.push(line);
      }
      const omitted = lines.length - shown.length;
      if (omitted > 0) shown.push(`  …and ${omitted} more line(s) — see the Convex logs`);
      console.log(`[tiers] reconcile report:\n${lines.join("\n")}`);
      await notifyQuietly(ctx, shown.join("\n"));
    }
  },
});

// ---- SMS allowance ----

/**
 * Texts a user may be sent per month and per day.
 *
 * SMS is the only channel that costs money per send, so unlike monitors or
 * scans these numbers are a budget rather than a product limit. At the UK rate
 * (~$0.056) a free user who spends their month costs about $0.56 against no
 * revenue, and a Max user about $11.20 against $29.
 *
 * The two windows stop different things. The month caps spend. The day stops a
 * page that starts flapping from burning a whole month before lunch — and from
 * texting someone ten times at 3am, which loses the user either way.
 *
 * Set low on purpose. Raising an allowance once real usage is visible costs
 * nothing; lowering one takes something away from people already using it.
 */
export const SMS_LIMITS: Record<Tier, { month: number; day: number }> = {
  free: { month: 10, day: 3 },
  sprint: { month: 25, day: 10 },
  pro: { month: 60, day: 20 },
  max: { month: 200, day: 50 },
};

const SMS_BUDGET_DEFAULT = 2000;

/**
 * Ceiling on texts across every user, in case a bug or an abuser defeats the
 * per-user caps. Past it SMS stops and alerts fall back to email, which is the
 * failure an operator would pick. 2000 sends is roughly $112 a month.
 *
 * Read through Number.isFinite rather than `??`, because an env var is a
 * string: a dashboard value of "" is not null, so `??` would not fire and
 * Number("") is 0 — SMS dead on arrival. A typo is worse. `used >= NaN` is
 * always false, so the backstop would quietly stop existing in exactly the
 * "the code is wrong" case it was written for.
 */
function smsMonthlyBudget(): number {
  // Trim first: a dashboard value of "" or "  " is not null, and Number("") is
  // 0 — finite, non-negative, and therefore a budget of zero that refuses
  // every text including verification codes. Only an unset var, a blank one or
  // a typo may reach the default.
  const raw = process.env.SMS_MONTHLY_BUDGET?.trim();
  if (!raw) return SMS_BUDGET_DEFAULT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : SMS_BUDGET_DEFAULT;
}

/**
 * Count one text against the ceiling that applies to everyone, or refuse.
 *
 * Shared by alerts and verification codes. A verification code is a real text
 * with a real cost, and it is the one send an unpaid attacker can reach, so
 * leaving it outside the budget would leave the backstop guarding the wrong
 * door. Called only once a send is actually going to happen, so a refusal
 * never consumes budget.
 */
export async function spendSmsBudget(ctx: MutationCtx): Promise<boolean> {
  const month = new Date().toISOString().slice(0, 7);
  const key = `sms:sends:${month}`;
  const budget = smsMonthlyBudget();

  const row = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", key))
    .unique();
  const used = row?.value ?? 0;

  if (used >= budget) {
    const alertKey = `sms:cap-alerted:${month}`;
    const alerted = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", alertKey))
      .unique();
    if (!alerted) {
      await ctx.db.insert("counters", { name: alertKey, value: Date.now() });
      await ctx.scheduler.runAfter(0, internal.admin.notify, {
        text: `PageAlert: the SMS budget for ${month} is spent (${budget} sends). Alerts fall back to email until next month.`,
      });
    }
    return false;
  }

  if (row) await ctx.db.patch(row._id, { value: used + 1 });
  else await ctx.db.insert("counters", { name: key, value: 1 });
  return true;
}

/** Why a send was refused. "budget" is ours; the others are the user's. */
export type SmsRefusal = "day" | "month" | "budget";

export interface SmsReservation {
  ok: boolean;
  reason?: SmsRefusal;
  /**
   * True on the one refusal that should still cost a text: the monthly
   * allowance has just run out and the user has not been told. The caller
   * sends that notice and nothing else until the month turns over.
   */
  notifyExhausted: boolean;
  monthLimit: number;
}

/**
 * Counts one text against the day, the month and the global budget, or refuses.
 *
 * A mutation rather than a check inside the sending action, so two monitors
 * firing in the same minute cannot both read "9 used" and both send.
 */
/**
 * Count one verification code against the account's daily allowance, or refuse.
 *
 * Lives on userTiers rather than on the phoneVerifications row because that row
 * is deleted on every terminal path — a confirmed code, an expired one, five
 * wrong guesses, the hourly sweep — so a counter held there would hand the
 * account a fresh three each time. The carrier-facing policy at /sms-policy
 * promises three a day, and this is what makes that true.
 *
 * The stamp is stored beside the count, like every other window in this file:
 * a stale day reads as zero and no cron has to reset anything.
 */
export const spendSmsCode = internalMutation({
  args: { userId: v.string(), day: v.string(), limit: v.number() },
  handler: async (ctx, { userId, day, limit }): Promise<{ ok: boolean }> => {
    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    const used = record?.smsCodeDay === day ? (record.smsCodeDayCount ?? 0) : 0;
    if (used >= limit) return { ok: false };

    if (record) {
      await ctx.db.patch(record._id, {
        smsCodeDay: day,
        smsCodeDayCount: used + 1,
        updatedAt: Date.now(),
      });
    } else {
      // A user who has never been near billing still has no userTiers row, and
      // the code request is the first thing that needs one.
      await ctx.db.insert("userTiers", {
        userId,
        tier: "free",
        smsCodeDay: day,
        smsCodeDayCount: 1,
        updatedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

/**
 * Give back an alert slot reserved for a text Twilio never accepted.
 *
 * reserveSmsSend spends the month, the day and the global budget before the
 * send, so a 500, a 429 or a timeout costs a user three things and delivers
 * nothing. The global counter is deliberately left alone: it is a spend
 * ceiling, refunding it needs a second write on the hot path, and erring
 * towards under-spending is the right way for a budget to be wrong.
 */
export const refundSmsSend = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!record) return;
    const patch: { smsMonthCount?: number; smsDayCount?: number; updatedAt: number } = {
      updatedAt: Date.now(),
    };
    if ((record.smsMonthCount ?? 0) > 0) patch.smsMonthCount = record.smsMonthCount! - 1;
    if ((record.smsDayCount ?? 0) > 0) patch.smsDayCount = record.smsDayCount! - 1;
    await ctx.db.patch(record._id, patch);
  },
});

/**
 * Give back a code slot spent on a send that never landed.
 *
 * Without it a number Twilio rejects — a geo block, a dead line, a
 * half-configured account — costs one of three daily attempts, and three of
 * those lock the user out until UTC midnight holding no working code.
 */
export const refundSmsCode = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    const used = record?.smsCodeDayCount ?? 0;
    if (!record || used <= 0) return;
    await ctx.db.patch(record._id, { smsCodeDayCount: used - 1, updatedAt: Date.now() });
  },
});

export const reserveSmsSend = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }): Promise<SmsReservation> => {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const day = now.toISOString().slice(0, 10);

    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    const tier = effectiveTier(record);
    const limits = SMS_LIMITS[tier];

    const monthUsed = record?.smsMonth === month ? (record.smsMonthCount ?? 0) : 0;
    const dayUsed = record?.smsDay === day ? (record.smsDayCount ?? 0) : 0;

    if (monthUsed >= limits.month) {
      // The "you are out" notice is itself a text, so it only goes out if the
      // global budget can carry it — and is marked spent in the same write
      // that refuses this alert, so it costs one text a month, not one per
      // refused alert.
      const owed =
        !!record && record.smsCapNotifiedMonth !== month && (await spendSmsBudget(ctx));
      if (owed && record) await ctx.db.patch(record._id, { smsCapNotifiedMonth: month });
      return { ok: false, reason: "month", notifyExhausted: owed, monthLimit: limits.month };
    }

    if (dayUsed >= limits.day) {
      return { ok: false, reason: "day", notifyExhausted: false, monthLimit: limits.month };
    }

    // Last, so that a send refused on either per-user cap costs no budget.
    if (!(await spendSmsBudget(ctx))) {
      return { ok: false, reason: "budget", notifyExhausted: false, monthLimit: limits.month };
    }

    if (record) {
      await ctx.db.patch(record._id, {
        smsMonth: month,
        smsMonthCount: monthUsed + 1,
        smsDay: day,
        smsDayCount: dayUsed + 1,
      });
    } else {
      await ctx.db.insert("userTiers", {
        userId,
        tier: "free",
        smsMonth: month,
        smsMonthCount: 1,
        smsDay: day,
        smsDayCount: 1,
        updatedAt: Date.now(),
      });
    }

    return { ok: true, notifyExhausted: false, monthLimit: limits.month };
  },
});

/** What the settings page shows: texts left this month, and the allowance. */
export const smsAllowance = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();

    const limits = SMS_LIMITS[effectiveTier(record)];
    const now = new Date();
    const usedThisMonth =
      record?.smsMonth === now.toISOString().slice(0, 7) ? (record.smsMonthCount ?? 0) : 0;
    const usedToday =
      record?.smsDay === now.toISOString().slice(0, 10) ? (record.smsDayCount ?? 0) : 0;

    return {
      monthLimit: limits.month,
      monthRemaining: Math.max(0, limits.month - usedThisMonth),
      dayLimit: limits.day,
      dayRemaining: Math.max(0, limits.day - usedToday),
    };
  },
});
