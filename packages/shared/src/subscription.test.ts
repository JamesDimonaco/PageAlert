import { describe, expect, it } from "vitest";
import { tierAlert, type TierChange } from "./subscription";

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
