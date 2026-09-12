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
  /** Prices found inside this block that fall in the user's range. */
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

export function findPrices(text: string): number[] {
  const prices: number[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    const n = parseFloat(raw.replace(/,/g, ""));
    if (Number.isFinite(n)) prices.push(n);
  }
  return prices;
}

/**
 * Split page text into candidate entries, one per link.
 *
 * Text before the first link is page chrome and is dropped. A page with no
 * links yields a single block covering everything, which is right for a
 * one-item page and no worse than a whole-page scan anywhere else.
 */
export function segmentPage(text: string): PageSegment[] {
  const starts: { at: number; title: string; url: string }[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    starts.push({ at: m.index ?? 0, title: (m[1] ?? "").trim(), url: m[2]! });
    if (starts.length >= MAX_SEGMENTS) break;
  }

  if (starts.length === 0) return [{ url: null, title: "", text }];

  return starts.map((start, i) => ({
    url: start.url,
    title: start.title,
    text: text.slice(start.at, i + 1 < starts.length ? starts[i + 1]!.at : text.length),
  }));
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
  const segments = segmentPage(text);
  const mustInclude = conditions.mustInclude ?? [];
  const mustExclude = conditions.mustExclude ?? [];
  const hasPriceFilter = conditions.priceMin != null || conditions.priceMax != null;

  const priced = segments.map((segment) => ({ segment, prices: findPrices(segment.text) }));

  // Some sites render a price outside the link that names the item, which puts
  // it in the neighbouring block or none at all. Silencing those monitors
  // would be worse than the over-matching being fixed here, so when the page
  // holds prices but no single block does, price falls back to the page.
  // Keywords stay per block either way.
  const pricesAreSegmented = priced.some((p) => p.prices.length > 0);
  const pagePricesInRange = pricesAreSegmented
    ? []
    : findPrices(text).filter((p) => inRange(p, conditions));

  const matches: SegmentMatch[] = [];
  for (const { segment, prices } of priced) {
    const withLinks = segment.text.toLowerCase();
    if (!mustInclude.every((kw) => withLinks.includes(kw.toLowerCase()))) continue;

    const visible = withoutLinkTargets(segment.text);
    if (mustExclude.some((kw) => visible.includes(kw.toLowerCase()))) continue;

    const pricesInRange = pricesAreSegmented
      ? prices.filter((p) => inRange(p, conditions))
      : pagePricesInRange;

    // An entry with no price cannot be known to sit inside a price range.
    if (hasPriceFilter && pricesInRange.length === 0) continue;

    matches.push({ ...segment, pricesInRange });
  }
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
