// Sorting and filters for the dashboard list. lastMatchAt moves only when a
// new item matches; matchCount is how many match on the page now. priceDropAt
// is when the latest price change, a fall, landed (see convex/priceMoves.ts).

type MatchFields = { matchCount: number; lastMatchAt?: number; priceDropAt?: number };

export const NEW_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const PRICE_DROP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const MATCH_FILTERS = [
  { value: "all", label: "All matches" },
  { value: "new", label: "New match (24h)" },
  { value: "matched", label: "Has matches" },
  { value: "none", label: "No matches" },
  { value: "price-drop", label: "Price dropped (7d)" },
] as const;
export type MatchFilter = (typeof MATCH_FILTERS)[number]["value"];

export const SORTS = [
  { value: "newest", label: "Newest" },
  { value: "recent-match", label: "Latest match" },
  { value: "most-matches", label: "Most matches" },
  { value: "name", label: "Name" },
] as const;
export type SortKey = (typeof SORTS)[number]["value"];

export function hasNewMatch(m: MatchFields, now: number): boolean {
  return m.lastMatchAt !== undefined && now - m.lastMatchAt <= NEW_MATCH_WINDOW_MS;
}

export function hasRecentPriceDrop(m: { priceDropAt?: number }, now: number): boolean {
  return m.priceDropAt !== undefined && now - m.priceDropAt <= PRICE_DROP_WINDOW_MS;
}

/** A product holds several monitors; it passes when any of them does. */
export function passesMatchFilter(monitors: MatchFields[], filter: MatchFilter, now: number): boolean {
  switch (filter) {
    case "all":
      return true;
    case "new":
      return monitors.some((m) => hasNewMatch(m, now));
    case "matched":
      return monitors.some((m) => m.matchCount > 0);
    case "none":
      return monitors.every((m) => m.matchCount === 0);
    case "price-drop":
      return monitors.some((m) => hasRecentPriceDrop(m, now));
  }
}

const latestMatch = (ms: MatchFields[]) => Math.max(0, ...ms.map((m) => m.lastMatchAt ?? 0));
const mostMatches = (ms: MatchFields[]) => Math.max(0, ...ms.map((m) => m.matchCount));

/** "newest" keeps the given order, which is newest first from the query. */
export function sortEntries<T extends { name: string; monitors: MatchFields[] }>(entries: T[], key: SortKey): T[] {
  const sorted = [...entries];
  if (key === "recent-match") sorted.sort((a, b) => latestMatch(b.monitors) - latestMatch(a.monitors));
  if (key === "most-matches") sorted.sort((a, b) => mostMatches(b.monitors) - mostMatches(a.monitors));
  if (key === "name") sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return sorted;
}
