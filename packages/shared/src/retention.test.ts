import { describe, expect, it } from "vitest";
import { HISTORY_WINDOW_DAYS, historyCutoff, isWithinHistoryWindow } from "./retention";
import type { TierName } from "./subscription";

const NOW = Date.UTC(2026, 8, 22, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const TIERS: TierName[] = ["free", "sprint", "pro", "max"];

describe("the advertised windows", () => {
  // These four numbers are printed on the pricing page and sold. Moving one
  // without moving the copy makes the page a lie, so the test moves too.
  it("is 7 days free, 30 sprint, 60 pro, 90 max", () => {
    expect(HISTORY_WINDOW_DAYS).toEqual({ free: 7, sprint: 30, pro: 60, max: 90 });
  });

  it("never hands a higher tier a shorter window", () => {
    const widths = TIERS.map((t) => HISTORY_WINDOW_DAYS[t]);
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
  });

  it("gives every tier something to look at", () => {
    for (const tier of TIERS) expect(HISTORY_WINDOW_DAYS[tier]).toBeGreaterThan(0);
  });
});

describe("historyCutoff", () => {
  it("puts the free cutoff a week back", () => {
    expect(historyCutoff("free", NOW)).toBe(NOW - 7 * DAY);
  });

  it("puts the max cutoff a quarter back", () => {
    expect(historyCutoff("max", NOW)).toBe(NOW - 90 * DAY);
  });
});

describe("isWithinHistoryWindow", () => {
  it("admits a row from this morning", () => {
    expect(isWithinHistoryWindow(NOW - 3 * 60 * 60 * 1000, "free", NOW)).toBe(true);
  });

  it("refuses a free row from eight days ago", () => {
    expect(isWithinHistoryWindow(NOW - 8 * DAY, "free", NOW)).toBe(false);
  });

  it("shows that same row to pro", () => {
    expect(isWithinHistoryWindow(NOW - 8 * DAY, "pro", NOW)).toBe(true);
  });

  // The boundary decides whether "7 days" means 7 or 6. Inclusive: a row
  // stamped exactly one window ago is still the user's to read.
  it("admits a row stamped exactly on the cutoff", () => {
    expect(isWithinHistoryWindow(NOW - 7 * DAY, "free", NOW)).toBe(true);
  });

  it("refuses the millisecond before it", () => {
    expect(isWithinHistoryWindow(NOW - 7 * DAY - 1, "free", NOW)).toBe(false);
  });

  // Clock skew between the scraper and Convex can stamp a row a little ahead.
  it("admits a row stamped in the future", () => {
    expect(isWithinHistoryWindow(NOW + 1000, "free", NOW)).toBe(true);
  });
});
