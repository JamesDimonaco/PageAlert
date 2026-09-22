/**
 * What to tell the operator when a customer's tier changes.
 *
 * Pure and separate from the mutation that writes the change, because the
 * interesting cases are combinations rather than code paths: Polar redelivers
 * webhooks, a subscription can replace a free trial at the same tier, and a
 * revoke can land on someone who still holds a manual grant. Two of those read
 * wrong when this logic lived inline.
 */

export type TierName = "free" | "sprint" | "pro" | "max";

export type TierChange = {
  /** Effective tier before the write. */
  before: TierName;
  /** Tier the webhook is asking for. */
  after: TierName;
  /** A live manual grant is being preserved, so nothing the customer pays for changed. */
  keptGrant: boolean;
  /** The kind of live grant this change replaces, if it replaces one. */
  replacedGrant?: "admin" | "pass";
};

export type TierAlert =
  /** Say nothing — a redelivered webhook, or a change the customer cannot feel. */
  | { kind: "none" }
  /** An admin trial turned into a real subscription. */
  | { kind: "converted"; tier: TierName }
  /** Money started, or moved up. */
  | { kind: "started"; tier: TierName; from: TierName }
  /** Money stopped. */
  | { kind: "ended"; from: TierName };

export function tierAlert(change: TierChange): TierAlert {
  const { before, after, keptGrant, replacedGrant } = change;

  // The grant outlives the subscription, so the customer sees no change.
  if (keptGrant) return { kind: "none" };

  if (after === "free") {
    // Nothing was being paid for, so nothing ended.
    if (before === "free") return { kind: "none" };
    return { kind: "ended", from: before };
  }

  // A real subscription replacing a free admin trial is the most interesting
  // sale there is, and by tier alone it looks like nothing happened. A pass is
  // not a trial — that customer already paid — so it reads as an ordinary
  // upgrade instead.
  if (replacedGrant === "admin") return { kind: "converted", tier: after };

  // Same tier either side and no grant replaced: a redelivered webhook.
  if (before === after) return { kind: "none" };

  return { kind: "started", tier: after, from: before };
}

/**
 * The reconcile decisions, kept here with tierAlert for the same reason: the
 * interesting part is which combination you are in, not the code path, and
 * combinations are worth a table with tests rather than conditions inline in
 * a Convex action that only a cron ever calls.
 */

/** Ordering for "never hand someone less than they already have" comparisons. */
export const TIER_RANK: Record<TierName, number> = { free: 0, sprint: 1, pro: 2, max: 3 };

export type ReconcileAction =
  /** The row is behind what Polar bills. Grant it — the harm reconcile exists for. */
  | "grant"
  /** Access is above what they pay for. Report it; a plan downgrade and a live admin trial look identical from here. */
  | "over-granted"
  /** Right tier, but the row does not name this subscription, so a later cancel webhook has nothing to match on. */
  | "link"
  /** Cache agrees with Polar. */
  | "none";

export function reconcileAction(args: {
  /** Effective tier the row currently grants. */
  cachedTier: TierName;
  /** Tier the live Polar subscription pays for. */
  polarTier: TierName;
  /** Whether the row already names this subscription. */
  isLinked: boolean;
}): ReconcileAction {
  if (TIER_RANK[args.cachedTier] < TIER_RANK[args.polarTier]) return "grant";
  if (TIER_RANK[args.cachedTier] > TIER_RANK[args.polarTier]) return "over-granted";
  return args.isLinked ? "none" : "link";
}

/**
 * Whether an incoming webhook describes an older state than the row holds.
 *
 * Polar retries a failed delivery up to ten times with exponential backoff, so
 * events do not arrive in the order they happened. The case that costs money:
 * a stale `subscription.created` — whose payload predates the cancellation and
 * so says cancel_at_period_end false — landing after `subscription.canceled`
 * and clearing it. The user then never learns when their access stops.
 *
 * Only compares within one subscription. A different id is a different
 * timeline, and its modified_at says nothing about this one.
 */
export function isStaleSubscriptionEvent(args: {
  storedSubscriptionId?: string;
  storedModifiedAt?: number;
  incomingSubscriptionId?: string;
  incomingModifiedAt?: number;
}): boolean {
  const { storedSubscriptionId, storedModifiedAt, incomingSubscriptionId, incomingModifiedAt } = args;
  if (incomingModifiedAt === undefined || storedModifiedAt === undefined) return false;
  if (!incomingSubscriptionId || storedSubscriptionId !== incomingSubscriptionId) return false;
  return incomingModifiedAt < storedModifiedAt;
}

/**
 * Which of two active subscriptions for one customer the row should reflect.
 *
 * Polar's org setting currently forbids holding two at once, so this is a
 * guard rather than a live case — but without it the row depended on the
 * order the API happened to return them, and a max alongside a cancelling pro
 * could leave the tier on max, the subscription id on pro, and the row marked
 * cancelled. Highest tier, then the later period end, then the id, so the
 * answer is the same whatever order they arrive in.
 */
export function preferSubscription<T extends { tier: TierName; periodEndMs: number; id: string }>(
  a: T,
  b: T,
): T {
  if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] > TIER_RANK[b.tier] ? a : b;
  if (a.periodEndMs !== b.periodEndMs) return a.periodEndMs > b.periodEndMs ? a : b;
  return a.id > b.id ? a : b;
}

export type CancellationAction =
  /** Write cancelledAt and periodEnd — new, corrected, or restored after a tier write wiped it. */
  | "mark"
  /** The customer reversed the cancellation; the row must stop saying it. */
  | "clear"
  | "none";

/**
 * What a row's cancellation fields should do, given what Polar now says.
 *
 * Both directions matter and only one of them used to exist. Nothing cleared a
 * cancellation, so a customer who resubscribed through the Polar portal kept
 * the amber "your plan has been cancelled" banner, and once the old period end
 * passed, "your access has expired" — while paying.
 */
export function cancellationAction(args: {
  polarCancelAtPeriodEnd: boolean;
  /** null when Polar gave no usable date. */
  polarPeriodEndMs: number | null;
  rowIsCancelled: boolean;
  rowPeriodEndMs?: number;
  /** A tier write this run already cleared the row's cancellation fields. */
  rowRewrittenThisRun: boolean;
}): CancellationAction {
  if (!args.polarCancelAtPeriodEnd) return args.rowIsCancelled ? "clear" : "none";
  // Guessing an end date is worse than leaving it: the user would be shown a
  // cutoff that is not when their access actually stops.
  if (args.polarPeriodEndMs === null) return "none";
  if (args.rowRewrittenThisRun || !args.rowIsCancelled) return "mark";
  return args.rowPeriodEndMs === args.polarPeriodEndMs ? "none" : "mark";
}

/**
 * The one product-id to tier mapping.
 *
 * The explicit undefined check is the whole point: with a product-id env var
 * unset and a payload whose productId is missing, `undefined === undefined`
 * hands out the top tier to an arbitrary subscriber.
 */
export function productTier(
  productId: string | undefined,
  ids: { pro?: string; max?: string },
): Extract<TierName, "pro" | "max"> | null {
  if (!productId) return null;
  if (ids.max && productId === ids.max) return "max";
  if (ids.pro && productId === ids.pro) return "pro";
  return null;
}
