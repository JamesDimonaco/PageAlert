import { describe, expect, it } from "vitest";
import {
  cancellationAction,
  isStaleSubscriptionEvent,
  productTier,
  preferSubscription,
  reconcileAction,
  tierAlert,
  type TierChange,
  type TierName,
} from "./subscription";

function change(o: Partial<TierChange> = {}): TierChange {
  return { before: "free", after: "pro", keptGrant: false, ...o };
}

describe("tierAlert", () => {
  it("announces a new subscriber", () => {
    expect(tierAlert(change())).toEqual({ kind: "started", tier: "pro", from: "free" });
  });

  it("says nothing when a redelivered webhook repeats a tier", () => {
    // Polar redelivers, and tiers.update is idempotent by design — without
    // this a retry reads as a second sale.
    expect(tierAlert(change({ before: "pro", after: "pro" }))).toEqual({ kind: "none" });
  });

  it("announces a trial that converted, even though the tier is unchanged", () => {
    // The sale that looks like nothing happened, and the one most worth knowing.
    expect(tierAlert(change({ before: "pro", after: "pro", replacedGrant: "admin" })))
      .toEqual({ kind: "converted", tier: "pro" });
  });

  it("treats a pass holder subscribing as an upgrade, not a conversion", () => {
    // They already paid us; they were never on a trial.
    expect(tierAlert(change({ before: "sprint", after: "pro", replacedGrant: "pass" })))
      .toEqual({ kind: "started", tier: "pro", from: "sprint" });
  });

  it("announces money stopping", () => {
    expect(tierAlert(change({ before: "pro", after: "free" }))).toEqual({ kind: "ended", from: "pro" });
  });

  it("says nothing when a revoke lands on someone who kept a grant", () => {
    // Their access is unchanged, so there is nothing to report.
    expect(tierAlert(change({ before: "pro", after: "free", keptGrant: true }))).toEqual({ kind: "none" });
  });

  it("says nothing when a revoke repeats on a free account", () => {
    expect(tierAlert(change({ before: "free", after: "free" }))).toEqual({ kind: "none" });
  });

  it("announces an upgrade between paid tiers", () => {
    expect(tierAlert(change({ before: "pro", after: "max" })))
      .toEqual({ kind: "started", tier: "max", from: "pro" });
  });
});

describe("reconcileAction", () => {
  const at = (cachedTier: TierName, polarTier: TierName, isLinked = true) =>
    reconcileAction({ cachedTier, polarTier, isLinked });

  it("grants when the row is behind what Polar bills", () => {
    // The six-month bug: an active pro subscription reading as free.
    expect(at("free", "pro")).toBe("grant");
    expect(at("pro", "max")).toBe("grant");
  });

  it("grants over a lapsed pass rather than leaving them short", () => {
    expect(at("sprint", "pro")).toBe("grant");
  });

  it("reports rather than demotes when access is above the bill", () => {
    // A max plan downgraded to pro keeps its subscription id, so this is the
    // only signal that the customer is over-served. Taking the tier away
    // would also hit anyone on a live admin trial, which looks identical.
    expect(at("max", "pro")).toBe("over-granted");
    expect(at("pro", "free")).toBe("over-granted");
  });

  it("links a matching tier whose row does not name the subscription", () => {
    // Without the id, a later cancel or revoke webhook has nothing to match.
    expect(at("pro", "pro", false)).toBe("link");
  });

  it("does nothing when the cache already agrees", () => {
    expect(at("pro", "pro", true)).toBe("none");
    expect(at("max", "max", true)).toBe("none");
  });
});

describe("isStaleSubscriptionEvent", () => {
  const sub = "sub_1";

  it("drops a replay that predates what the row knows", () => {
    // Polar retries up to ten times with backoff. A stale subscription.created
    // says cancel_at_period_end false and would wipe a newer cancellation,
    // leaving the customer never told when their access stops.
    expect(
      isStaleSubscriptionEvent({
        storedSubscriptionId: sub,
        storedModifiedAt: 2_000,
        incomingSubscriptionId: sub,
        incomingModifiedAt: 1_000,
      }),
    ).toBe(true);
  });

  it("accepts a newer event, and a redelivery of the same one", () => {
    const base = { storedSubscriptionId: sub, storedModifiedAt: 2_000, incomingSubscriptionId: sub };
    expect(isStaleSubscriptionEvent({ ...base, incomingModifiedAt: 3_000 })).toBe(false);
    // Equal is not older — tiers.update is idempotent, so letting it through
    // costs nothing and dropping it would strand a genuine same-moment retry.
    expect(isStaleSubscriptionEvent({ ...base, incomingModifiedAt: 2_000 })).toBe(false);
  });

  it("never judges one subscription by another's clock", () => {
    // A customer resubscribing gets a new id; the old timeline says nothing
    // about it, and treating it as stale would lock them out of the new tier.
    expect(
      isStaleSubscriptionEvent({
        storedSubscriptionId: "sub_old",
        storedModifiedAt: 9_000,
        incomingSubscriptionId: "sub_new",
        incomingModifiedAt: 1_000,
      }),
    ).toBe(false);
  });

  it("lets an event through when either side has no stamp", () => {
    // Rows written before this field existed, so the guard must not block
    // every future write to them.
    expect(
      isStaleSubscriptionEvent({ storedSubscriptionId: sub, incomingSubscriptionId: sub, incomingModifiedAt: 1_000 }),
    ).toBe(false);
    expect(
      isStaleSubscriptionEvent({ storedSubscriptionId: sub, storedModifiedAt: 2_000, incomingSubscriptionId: sub }),
    ).toBe(false);
  });
});

describe("preferSubscription", () => {
  const s = (id: string, tier: TierName, periodEndMs: number) => ({ id, tier, periodEndMs });

  it("prefers the higher tier", () => {
    expect(preferSubscription(s("a", "pro", 100), s("b", "max", 100)).id).toBe("b");
  });

  it("falls back to the later period end, then the id", () => {
    expect(preferSubscription(s("a", "pro", 100), s("b", "pro", 200)).id).toBe("b");
    expect(preferSubscription(s("a", "pro", 100), s("b", "pro", 100)).id).toBe("b");
  });

  it("gives the same answer whichever order they arrive in", () => {
    // The whole point: the row must not depend on Polar's list order.
    const x = s("a", "max", 100);
    const y = s("b", "pro", 900);
    expect(preferSubscription(x, y).id).toBe(preferSubscription(y, x).id);
  });
});

describe("cancellationAction", () => {
  const live = { polarCancelAtPeriodEnd: true, polarPeriodEndMs: 5_000 };

  it("marks a cancellation the row does not know about", () => {
    expect(cancellationAction({ ...live, rowIsCancelled: false, rowRewrittenThisRun: false })).toBe("mark");
  });

  it("re-marks one this run just wiped", () => {
    // update() clears cancelledAt unconditionally, so a grant applied to a
    // cancelling subscription has to put the end date back or the user is
    // never told when access stops.
    // rowPeriodEndMs deliberately matches: without the rewrite clause this
    // falls through to "nothing changed, do nothing" and the wipe stands.
    expect(
      cancellationAction({ ...live, rowIsCancelled: true, rowPeriodEndMs: 5_000, rowRewrittenThisRun: true }),
    ).toBe("mark");
  });

  it("corrects a cancellation whose end date has moved", () => {
    // A cancel webhook that fell back to "30 days from now" instead of the
    // real period end leaves the user a wrong expiry date forever.
    expect(
      cancellationAction({ ...live, rowIsCancelled: true, rowPeriodEndMs: 9_999, rowRewrittenThisRun: false }),
    ).toBe("mark");
  });

  it("does nothing when the row already says exactly this", () => {
    expect(
      cancellationAction({ ...live, rowIsCancelled: true, rowPeriodEndMs: 5_000, rowRewrittenThisRun: false }),
    ).toBe("none");
  });

  it("clears a cancellation the customer has reversed", () => {
    // Resubscribing through the Polar portal fires uncanceled. Without this
    // the settings page keeps showing "your plan has been cancelled", and
    // after the old period end, "your access has expired" — to someone paying.
    expect(
      cancellationAction({
        polarCancelAtPeriodEnd: false,
        polarPeriodEndMs: 5_000,
        rowIsCancelled: true,
        rowRewrittenThisRun: false,
      }),
    ).toBe("clear");
  });

  it("does nothing for an ordinary uncancelled subscription", () => {
    expect(
      cancellationAction({
        polarCancelAtPeriodEnd: false,
        polarPeriodEndMs: 5_000,
        rowIsCancelled: false,
        rowRewrittenThisRun: false,
      }),
    ).toBe("none");
  });

  it("will not mark a cancellation it has no end date for", () => {
    // Guessing the date is worse than leaving it: the user would be shown a
    // cutoff that is not when their access actually stops.
    expect(
      cancellationAction({
        polarCancelAtPeriodEnd: true,
        polarPeriodEndMs: null,
        rowIsCancelled: false,
        rowRewrittenThisRun: false,
      }),
    ).toBe("none");
  });
});

describe("productTier", () => {
  const ids = { pro: "prod_pro", max: "prod_max" };

  it("maps the configured products", () => {
    expect(productTier("prod_pro", ids)).toBe("pro");
    expect(productTier("prod_max", ids)).toBe("max");
  });

  it("returns null for anything else", () => {
    expect(productTier("prod_sprint", ids)).toBeNull();
  });

  it("never matches undefined against an unset product id", () => {
    // The trap: with POLAR_MAX_PRODUCT_ID unset and a payload whose productId
    // is missing, undefined === undefined would hand out the top tier.
    expect(productTier(undefined, { pro: undefined, max: undefined })).toBeNull();
    expect(productTier(undefined, ids)).toBeNull();
    expect(productTier("prod_pro", { pro: undefined, max: undefined })).toBeNull();
  });
});
