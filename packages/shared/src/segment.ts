import type { MatchConditions } from "./types";

/** A slice of page text that looks like one listing entry. */
export interface PageSegment {
  /** The entry's own link. Also its identity, so a match can be diffed against last check. */
  url: string | null;
  /** The link's own text — the entry's title on almost every listing layout. */
  title: string;
  text: string;
}

export interface SegmentMatch extends PageSegment {
  /** Prices attributed to this entry that fall in the user's range. */
  pricesInRange: number[];
}

const LINK_RE = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g;

/**
 * Currency amounts in page text.
 *
 * The pattern this replaces matched `$` only, so on a GBP or EUR page it found
 * nothing — and "no prices found" was read as "the price condition holds",
 * which let every price filter through on most of the non-US web.
 */
const PRICE_RE =
  /[$£€]\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(?:USD|GBP|EUR|AUD|CAD)\b/gi;

/** Stops an index page of thousands of links doing per-segment work forever. */
const MAX_SEGMENTS = 500;

interface LinkMark {
  at: number;
  /** First character after the `[title](url)` markup. */
  end: number;
  title: string;
  url: string;
}

function linkMarks(text: string): LinkMark[] {
  const marks: LinkMark[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const at = m.index ?? 0;
    marks.push({ at, end: at + m[0].length, title: (m[1] ?? "").trim(), url: m[2]! });
    if (marks.length >= MAX_SEGMENTS) break;
  }
  return marks;
}

interface PriceHit {
  value: number;
  at: number;
}

function findPriceHits(text: string): PriceHit[] {
  const hits: PriceHit[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    const value = parseFloat(raw.replace(/,/g, ""));
    if (Number.isFinite(value)) hits.push({ value, at: m.index ?? 0 });
  }
  return hits;
}

export function findPrices(text: string): number[] {
  return findPriceHits(text).map((hit) => hit.value);
}

/**
 * An entry's text with its link target removed.
 *
 * Used for excludes only. A URL carries words the user never sees — "black"
 * appears in `/black-friday/` on every item in a sale — and an exclude that
 * fires on one of those silently drops a listing the user wanted, which
 * nothing downstream can recover. Includes still read the URL, because a slug
 * is often the only place the full title survives: listing markup truncates
 * link text to "A Light in the ...". An include that fires on an unrelated
 * slug only promotes the entry to being judged, and the judge drops it.
 */
function withoutLinkTargets(text: string): string {
  return text.replace(/\]\((https?:\/\/[^)\s]+)\)/g, "]").toLowerCase();
}

/**
 * Split page text into candidate entries, one per link.
 *
 * Text before the first link is page chrome and is dropped. A page with no
 * links yields a single block covering everything, which is right for a
 * one-item page and no worse than a whole-page scan anywhere else.
 */
export function segmentPage(text: string): PageSegment[] {
  const marks = linkMarks(text);
  if (marks.length === 0) return [{ url: null, title: "", text }];

  return marks.map((mark, i) => ({
    url: mark.url,
    title: mark.title,
    text: text.slice(mark.at, i + 1 < marks.length ? marks[i + 1]!.at : text.length),
  }));
}

/**
 * Which entry each price on the page belongs to.
 *
 * A price sitting between two links could belong to either — the card above
 * it or the card below. Splitting on links alone always guessed "above",
 * which handed every entry its neighbour's price on the layouts that put the
 * price first. The page picks one answer for all of its entries: whichever
 * side most of its prices sit nearer to is the side they describe.
 *
 * Deciding per page rather than per price is the point. Letting each price
 * pick its own nearest link would put a cheap accessory's price back inside
 * an expensive listing's block, which is the pairing this module exists to
 * stop.
 */
function pricesByEntry(text: string, marks: LinkMark[]): number[][] {
  const perEntry: number[][] = marks.map(() => []);
  const hits = findPriceHits(text);
  if (hits.length === 0 || marks.length === 0) return perEntry;

  const entryBefore = (at: number): number => {
    let lo = 0;
    let hi = marks.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid]!.at <= at) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  let nearerToNext = 0;
  const placed = hits.map((hit) => {
    const before = entryBefore(hit.at);
    const after = before + 1 < marks.length ? before + 1 : -1;
    // Measured from where the link markup ends, not where it starts. A long
    // URL would otherwise push every price away from the title above it and
    // flip the whole page to the wrong reading.
    const gapBefore = before >= 0 ? hit.at - marks[before]!.end : Infinity;
    const gapAfter = after >= 0 ? marks[after]!.at - hit.at : Infinity;
    if (gapAfter < gapBefore) nearerToNext++;
    return { hit, before, after };
  });

  // Titles above prices is what most listing markup does, so flipping needs a
  // clear majority rather than a coin toss on an evenly spaced page.
  const priceLeadsTitle = nearerToNext > hits.length * 0.6;
  for (const { hit, before, after } of placed) {
    const owner = priceLeadsTitle ? after : before;
    if (owner >= 0) perEntry[owner]!.push(hit.value);
  }
  return perEntry;
}

function inRange(price: number, c: MatchConditions): boolean {
  if (c.priceMin != null && price < c.priceMin) return false;
  if (c.priceMax != null && price > c.priceMax) return false;
  return true;
}

/**
 * Entries where every match condition holds *within that one entry*.
 *
 * The whole-page scan this replaces asked only whether the keywords and a
 * price in range appeared somewhere on the page, so a £200 case and a £3000
 * laptop listed together satisfied "laptop under £500" between them. Nothing
 * tied the two facts to the same product.
 */
export function matchPageSegments(
  text: string,
  conditions: MatchConditions
): SegmentMatch[] {
  const marks = linkMarks(text);
  const segments = segmentPage(text);
  const mustInclude = conditions.mustInclude ?? [];
  const mustExclude = conditions.mustExclude ?? [];
  const hasPriceFilter = conditions.priceMin != null || conditions.priceMax != null;

  const perEntry = pricesByEntry(text, marks);

  // Some sites render prices somewhere no entry reaches at all. Falling back
  // to the page keeps those monitors alive rather than silencing them, and
  // keywords stay per entry either way, so the pairing this module exists to
  // stop cannot return through the keyword side.
  const anyEntryPriced = perEntry.some((prices) => prices.length > 0);
  const pagePricesInRange = anyEntryPriced
    ? []
    : findPrices(text).filter((price) => inRange(price, conditions));

  const matches: SegmentMatch[] = [];
  segments.forEach((segment, i) => {
    const withLinks = segment.text.toLowerCase();
    if (!mustInclude.every((kw) => withLinks.includes(kw.toLowerCase()))) return;

    const visible = withoutLinkTargets(segment.text);
    if (mustExclude.some((kw) => visible.includes(kw.toLowerCase()))) return;

    const pricesInRange = anyEntryPriced
      ? (perEntry[i] ?? []).filter((price) => inRange(price, conditions))
      : pagePricesInRange;

    // An entry with no price cannot be known to sit inside a price range.
    if (hasPriceFilter && pricesInRange.length === 0) return;

    matches.push({ ...segment, pricesInRange });
  });

  return matches;
}

/**
 * Score at or above which a judged entry is worth waking someone up for.
 *
 * Below this the entry cleared the keyword filter but the model could not tie
 * it to what the user asked for — the wrong variant, out of stock, or a promo
 * block that happened to carry the words. Those stay visible on the monitor
 * page; they just do not send anything.
 */
export const MATCH_SCORE_THRESHOLD = 60;

/**
 * Is a judged entry worth sending?
 *
 * Null means the judgement never came back — a scraper outage, a timeout, a
 * reply that would not parse. Those still alert. The keyword filter already
 * vouched for the entry, and a missed restock cannot be recovered, whereas a
 * weak match the user can dismiss. Reading "no verdict" as a low score once
 * retired real listings into the seen set and silenced them for good.
 */
export function alertsOnScore(score: number | null | undefined): boolean {
  return score == null || score >= MATCH_SCORE_THRESHOLD;
}

export type MatchConfidence = "strong" | "likely" | "weak";

/**
 * A judged score as a band.
 *
 * The number is the model's own estimate and is not calibrated — a 78 and an
 * 84 do not reliably differ. Bands are what the user should be reading; the
 * raw score stays available for anyone who wants it, and for measuring these
 * bands against the thumbs data later.
 */
export function matchConfidence(score: number): MatchConfidence {
  if (score >= 85) return "strong";
  if (score >= MATCH_SCORE_THRESHOLD) return "likely";
  return "weak";
}

export const MATCH_CONFIDENCE_LABEL: Record<MatchConfidence, string> = {
  strong: "Strong match",
  likely: "Likely match",
  weak: "Weak match",
};
