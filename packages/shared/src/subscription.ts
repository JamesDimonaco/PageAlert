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
