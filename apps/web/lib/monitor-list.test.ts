import { describe, expect, it } from "vitest";
import { NEW_MATCH_WINDOW_MS, PRICE_DROP_WINDOW_MS, dropRatio, hasNewMatch, hasRecentPriceDrop, passesMatchFilter, sortEntries } from "./monitor-list";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const m = (matchCount: number, lastMatchAt?: number) => ({ matchCount, lastMatchAt });

describe("hasNewMatch", () => {
  it("counts a match inside the last 24 hours as new", () => {
    expect(NEW_MATCH_WINDOW_MS).toBe(24 * HOUR);
    expect(hasNewMatch(m(1, NOW - 23 * HOUR), NOW)).toBe(true);
    expect(hasNewMatch(m(1, NOW - NEW_MATCH_WINDOW_MS), NOW)).toBe(true);
    expect(hasNewMatch(m(1, NOW - NEW_MATCH_WINDOW_MS - 1), NOW)).toBe(false);
    expect(hasNewMatch(m(0), NOW)).toBe(false);
  });
});

describe("passesMatchFilter", () => {
  const fresh = m(2, NOW - HOUR);
  const stale = m(3, NOW - 5 * 24 * HOUR);
  const empty = m(0);

  it("all lets everything through", () => {
    expect(passesMatchFilter([empty], "all", NOW)).toBe(true);
  });

  it("new keeps only a match in the window", () => {
    expect(passesMatchFilter([fresh], "new", NOW)).toBe(true);
    expect(passesMatchFilter([stale], "new", NOW)).toBe(false);
  });

  it("matched keeps anything with a match on the page now", () => {
    expect(passesMatchFilter([stale], "matched", NOW)).toBe(true);
    expect(passesMatchFilter([empty], "matched", NOW)).toBe(false);
  });

  it("none keeps only pages with no match", () => {
    expect(passesMatchFilter([empty], "none", NOW)).toBe(true);
    expect(passesMatchFilter([stale], "none", NOW)).toBe(false);
  });

  it("a product passes when any of its listings does", () => {
    expect(passesMatchFilter([empty, fresh], "new", NOW)).toBe(true);
    expect(passesMatchFilter([empty, fresh], "none", NOW)).toBe(false);
  });
});

describe("hasRecentPriceDrop", () => {
  it("shows a drop for 7 days", () => {
    expect(PRICE_DROP_WINDOW_MS).toBe(7 * 24 * HOUR);
    const at = (at: number) => ({ lastPriceDrop: { from: 100, to: 80, currency: "GBP", at } });
    expect(hasRecentPriceDrop(at(NOW - PRICE_DROP_WINDOW_MS), NOW)).toBe(true);
    expect(hasRecentPriceDrop(at(NOW - PRICE_DROP_WINDOW_MS - 1), NOW)).toBe(false);
    expect(hasRecentPriceDrop({}, NOW)).toBe(false);
  });

  it("the price-drop filter keeps a product when any listing dropped", () => {
    const dropped = { ...m(0), lastPriceDrop: { from: 100, to: 80, currency: "GBP", at: NOW - HOUR } };
    expect(passesMatchFilter([m(0), dropped], "price-drop", NOW)).toBe(true);
    expect(passesMatchFilter([m(3, NOW - HOUR)], "price-drop", NOW)).toBe(false);
  });
});

describe("dropRatio", () => {
  it("is the fall as a share of the old price", () => {
    expect(dropRatio({ from: 10000, to: 8800 })).toBeCloseTo(0.12);
  });
});

describe("sortEntries", () => {
  const entries = [
    { name: "banana", monitors: [m(1, NOW - 3 * HOUR)] },
    { name: "Apple", monitors: [m(0)] },
    { name: "cherry", monitors: [m(5, NOW - 2 * 24 * HOUR)] },
    { name: "date", monitors: [m(0), m(2, NOW - HOUR)] },
  ];
  const names = (key: Parameters<typeof sortEntries>[1]) => sortEntries(entries, key).map((e) => e.name);

  it("newest keeps the order it was given", () => {
    expect(names("newest")).toEqual(["banana", "Apple", "cherry", "date"]);
  });

  it("recent match puts the latest match first and never-matched last", () => {
    expect(names("recent-match")).toEqual(["date", "banana", "cherry", "Apple"]);
  });

  it("most matches ranks by the busiest listing", () => {
    expect(names("most-matches")).toEqual(["cherry", "date", "banana", "Apple"]);
  });

  it("name sorts A to Z ignoring case", () => {
    expect(names("name")).toEqual(["Apple", "banana", "cherry", "date"]);
  });

  it("does not reorder the input", () => {
    sortEntries(entries, "name");
    expect(entries[0].name).toBe("banana");
  });
});
