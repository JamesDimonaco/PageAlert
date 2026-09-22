import { describe, expect, it } from "vitest";
import {
  HISTORY_WINDOW_DAYS,
  MAX_HISTORY_WINDOW_DAYS,
  MAX_RAW_RESPONSE_BYTES,
  capRawResponse,
  historyCutoff,
  isWithinHistoryWindow,
} from "./retention";
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

describe("MAX_HISTORY_WINDOW_DAYS", () => {
  // The detail page tells a user whose check is past every window that it is
  // older than this many days. If it stopped being the largest it would name
  // a number smaller than what some plan actually shows.
  it("is the largest window any plan gets", () => {
    for (const tier of TIERS) {
      expect(HISTORY_WINDOW_DAYS[tier]).toBeLessThanOrEqual(MAX_HISTORY_WINDOW_DAYS);
    }
    expect(Object.values(HISTORY_WINDOW_DAYS)).toContain(MAX_HISTORY_WINDOW_DAYS);
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

  // Convex stamps createdAt itself, so this cannot arise today. Pinned because
  // a backfill that lands one is better shown than silently swallowed.
  it("admits a row stamped in the future", () => {
    expect(isWithinHistoryWindow(NOW + 1000, "free", NOW)).toBe(true);
  });
});

describe("capRawResponse", () => {
  const byteLen = (s: string) => new TextEncoder().encode(s).length;
  // The suffix added on truncation, plus up to 3 bytes of replacement
  // character from a cut that lands mid-sequence.
  const SLACK = byteLen("\n…truncated") + 3;

  it("leaves undefined alone", () => {
    expect(capRawResponse(undefined)).toBeUndefined();
  });

  it("leaves a string under the cap untouched", () => {
    const small = "x".repeat(100);
    expect(capRawResponse(small)).toBe(small);
  });

  it("leaves a string exactly on the cap untouched", () => {
    const exact = "x".repeat(MAX_RAW_RESPONSE_BYTES);
    expect(capRawResponse(exact)).toBe(exact);
  });

  it("truncates one byte over", () => {
    const over = "x".repeat(MAX_RAW_RESPONSE_BYTES + 1);
    expect(capRawResponse(over)).not.toBe(over);
  });

  // The bug this exists for. The old limit counted characters, so 50,000 of
  // them passed as "50KB" while actually being 200KB — and the logs page size
  // was calculated against that made-up ceiling.
  it("counts bytes, not characters", () => {
    const emoji = "🙂".repeat(50000);
    expect(byteLen(emoji)).toBe(200000);
    expect(byteLen(capRawResponse(emoji)!)).toBeLessThanOrEqual(MAX_RAW_RESPONSE_BYTES + SLACK);
  });

  it("holds the bound when the cut lands mid-sequence", () => {
    const wide = "あ".repeat(20000); // 60,000 bytes, three per character
    expect(byteLen(capRawResponse(wide)!)).toBeLessThanOrEqual(MAX_RAW_RESPONSE_BYTES + SLACK);
  });

  // What the logs page size rests on: no row can cost more than this.
  it("bounds every input, whatever its encoding", () => {
    const inputs = ["x".repeat(1000000), "🙂".repeat(100000), "あ".repeat(100000), "√".repeat(100000)];
    for (const input of inputs) {
      expect(byteLen(capRawResponse(input)!)).toBeLessThanOrEqual(MAX_RAW_RESPONSE_BYTES + SLACK);
    }
  });
});
