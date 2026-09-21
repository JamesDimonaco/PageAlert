import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { tierAlert, type TierChange } from "@prowl/shared";

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

/** Ordering for "don't downgrade someone who already has more" comparisons */
export const TIER_RANK: Record<Tier, number> = { free: 0, sprint: 1, pro: 2, max: 3 };

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

/** Internal mutation for webhook-triggered tier updates */
export const update = internalMutation({
  args: {
    userId: v.string(),
    tier: tierValidator,
    polarCustomerId: v.optional(v.string()),
    polarSubscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();

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
      await ctx.db.patch(existing._id, patch);
      const liveGrant = !!existing.grantUntil && existing.grantUntil > Date.now();
      await announce(ctx, args.userId, {
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
      await ctx.db.insert("userTiers", doc as any);
      await announce(ctx, args.userId, { before: "free", after: args.tier, keptGrant: false });
    }
  },
});

/** Internal mutation for marking a subscription as cancelled (still active until period end) */
export const markCancelled = internalMutation({
  args: {
    userId: v.string(),
    periodEnd: v.number(),
    polarSubscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();

    if (!existing) {
      console.warn("[tiers] markCancelled: no userTiers record for userId:", args.userId, "sub:", args.polarSubscriptionId);
      return;
    }

    // Already says exactly this. Returning early keeps cancelledAt meaning
    // "when they cancelled" rather than "when a job last looked", now that
    // reconcile re-asserts cancellations on every run.
    if (existing.cancelledAt && existing.periodEnd === args.periodEnd) return;

    const patch: Record<string, unknown> = {
      cancelledAt: Date.now(),
      periodEnd: args.periodEnd,
      updatedAt: Date.now(),
    };
    if (args.polarSubscriptionId != null) patch.polarSubscriptionId = args.polarSubscriptionId;
    await ctx.db.patch(existing._id, patch);

    // Distinct from the revoke above: they still have access until periodEnd,
    // so this is the one with time left to do something about it.
    if (!existing.cancelledAt) {
      const until = new Date(args.periodEnd).toLocaleDateString("en-GB", {
        day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
      });
      await ctx.scheduler.runAfter(0, internal.admin.notify, {
        text: `⚠️ Cancelled: ${effectiveTier(existing)} subscription, access until ${until} (${args.userId})`,
      });
    }
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
  status: string;
  product_id?: string;
  customer_id?: string;
  cancel_at_period_end?: boolean;
  current_period_end?: string | null;
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
    }));
  },
});

export const reconcile = internalAction({
  args: {},
  handler: async (ctx) => {
    const token = process.env.POLAR_ACCESS_TOKEN;
    if (!token) {
      console.warn("[tiers] reconcile: POLAR_ACCESS_TOKEN not set, skipping");
      return;
    }
    const proProductId = process.env.POLAR_PRO_PRODUCT_ID;
    const maxProductId = process.env.POLAR_MAX_PRODUCT_ID;

    let subscriptions: PolarSubscription[];
    try {
      subscriptions = await fetchActiveSubscriptions(token, process.env.POLAR_ENVIRONMENT === "production");
    } catch (err) {
      // A reconcile that fails quietly is the bug it was written to catch, so
      // this is the one failure worth interrupting for.
      await ctx.runAction(internal.admin.notify, {
        text: `🚨 Billing reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }

    const wanted: { userId: string; tier: Tier; sub: PolarSubscription }[] = [];
    const unknownProduct: string[] = [];
    const noExternalId: string[] = [];

    for (const sub of subscriptions) {
      const userId = sub.customer?.external_id;
      if (!userId) {
        noExternalId.push(sub.id);
        continue;
      }
      const tier: Tier | null =
        sub.product_id && sub.product_id === maxProductId
          ? "max"
          : sub.product_id && sub.product_id === proProductId
            ? "pro"
            : null;
      if (!tier) {
        unknownProduct.push(`${sub.id} (product ${sub.product_id})`);
        continue;
      }
      wanted.push({ userId, tier, sub });
    }

    const cached = wanted.length
      ? await ctx.runQuery(internal.tiers.cachedStateFor, { userIds: wanted.map((w) => w.userId) })
      : [];
    const cachedByUser = new Map(cached.map((c) => [c.userId, c]));

    const granted: string[] = [];
    const linked: string[] = [];
    const overGranted: string[] = [];

    // What this run has already written, so a customer holding two active
    // subscriptions is judged against the row as it stands rather than the
    // pre-loop snapshot. Without it the second subscription reads the stale
    // "free" and update() — which has no rank guard — demotes the first.
    const writtenTier = new Map<string, Tier>();

    for (const { userId, tier, sub } of wanted) {
      const current = cachedByUser.get(userId);
      const currentTier = writtenTier.get(userId) ?? current?.tier ?? "free";
      const isLinked = current?.subscriptionId === sub.id;
      let cancellationCleared = false;

      const applyTier = async (outcome: string[], label: string) => {
        await ctx.runMutation(internal.tiers.update, {
          userId,
          tier,
          ...(sub.customer_id ? { polarCustomerId: sub.customer_id } : {}),
          polarSubscriptionId: sub.id,
        });
        writtenTier.set(userId, tier);
        // update() clears cancelledAt/periodEnd unconditionally, so anything
        // below has to put a live cancellation back rather than trust the
        // snapshot taken before this write.
        cancellationCleared = true;
        outcome.push(label);
      };

      if (TIER_RANK[currentTier] < TIER_RANK[tier]) {
        // Underserving someone who is being billed — the harm this job exists
        // for.
        await applyTier(granted, `${userId}: ${currentTier} → ${tier}`);
      } else if (TIER_RANK[currentTier] > TIER_RANK[tier]) {
        // Access above what they pay for. Report only: a plan downgrade and a
        // live admin trial look identical from here, and taking a tier away
        // from the wrong one of those is the costlier mistake.
        overGranted.push(`${userId}: on ${currentTier}, Polar bills ${tier} (sub ${sub.id})`);
      } else if (!isLinked) {
        // Right tier, but the row does not name this subscription — so a later
        // cancel or revoke webhook has nothing to match on. Writing the id is
        // what stops this reappearing in tomorrow's message unchanged.
        await applyTier(linked, `${userId}: ${tier} linked to sub ${sub.id}`);
      }

      const periodEnd = sub.current_period_end ? new Date(sub.current_period_end).getTime() : NaN;
      if (sub.cancel_at_period_end && Number.isFinite(periodEnd)) {
        // Skipped only when the cached row is already cancelled AND this run
        // did not just wipe that state. markCancelled is itself a no-op when
        // the row already says the same thing.
        if (cancellationCleared || !current?.isCancelled) {
          await ctx.runMutation(internal.tiers.markCancelled, {
            userId,
            periodEnd,
            polarSubscriptionId: sub.id,
          });
        }
      }
    }

    const fixed = granted.length + linked.length;
    console.log(
      `[tiers] reconcile: ${subscriptions.length} active sub(s), ${granted.length} granted, ` +
        `${linked.length} linked, ${overGranted.length} over-granted`,
    );

    // Silent when there is nothing wrong. The daily pulse already proves the
    // crons are alive, so a heartbeat here would only add noise to the channel
    // that has to stay worth reading.
    const repaired = [
      ...granted.map((g) => `  granted ${g}`),
      ...linked.map((l) => `  linked ${l}`),
    ];
    // These need a person. They repeat every morning until someone acts,
    // which is the point — nothing else in the system mentions them.
    const needsYou = [
      ...overGranted.map((o) => `  over-granted ${o}`),
      ...unknownProduct.map((u) => `  unknown product ${u}`),
      ...noExternalId.map((n) => `  no external id ${n}`),
    ];
    if (repaired.length || needsYou.length) {
      const headline = needsYou.length
        ? `🔁 Billing reconcile: fixed ${fixed}, ${needsYou.length} need(s) you`
        : `🔁 Billing reconcile: fixed ${fixed}`;
      await ctx.runAction(internal.admin.notify, {
        text: [headline, ...repaired, ...needsYou].join("\n"),
      });
    }
  },
});
