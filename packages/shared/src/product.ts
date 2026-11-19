import { canonicalUrl } from "./url-identity";
import type { ExtractedItem } from "./types";

/**
 * The product on a product page, or null on a listing.
 *
 * It is the one item that links to the page itself. Product pages often show
 * related items too, so counting items alone called them listings and stock
 * and price alerts never ran. With no such item, a page holding exactly one
 * item is that item's page.
 */
export function productItem(schema: unknown, pageUrl: string): ExtractedItem | null {
  // Its items are shops' offers, so neither rule below means anything there.
  if (isComparisonSite(pageUrl)) return null;
  const items = (schema as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return null;
  const page = canonicalUrl(pageUrl);
  const own = items.filter(
    (item: ExtractedItem) => typeof item?.url === "string" && item.url && canonicalUrl(item.url) === page
  );
  if (own.length === 1) return own[0];
  if (items.length === 1) return items[0];
  return null;
}

/**
 * Price comparison and deal sites in the search regions, matched on the site
 * name in the hostname. Both list other shops' offers and sell nothing.
 */
const COMPARISON_SITE =
  /(^|\.)(pricespy|priceme|pricerunner|pcpartpicker|idealo|kelkoo|geizhals|billiger|guenstiger|ledenicheur|trovaprezzi|kieskeurig|tweakers|beslist|staticice|getprice|shopbot|pricehipster|pricegrabber|cheapies|ozbargain|hotukdeals|slickdeals|mydealz)\./;

/** A page listing one product's offers from many shops, rather than a shop's own page. */
export function isComparisonSite(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    const googleShopping = /(^|\.)google\./.test(hostname) && (hostname.startsWith("shopping.") || pathname.startsWith("/shopping"));
    return COMPARISON_SITE.test(hostname) || googleShopping;
  } catch {
    return false;
  }
}

/**
 * An airport or duty-free shop, which sells only to travellers. Matched on a
 * hostname label ending in "airport" ("aucklandairport", not
 * "airportparking") or holding "dutyfree".
 */
export function isTravellerOnlyShop(url: string): boolean {
  try {
    return new URL(url).hostname.split(".").some((label) => /airport$|duty-?free/.test(label));
  } catch {
    return false;
  }
}

/** Path segments of editorial pages, which shops publish beside their products. */
const ARTICLE_SEGMENT = /^(blog|blogs|news|article|articles|review|reviews)$/i;

/**
 * A blog post, news story or review: a page about a product, not one selling
 * it. Guides and magazines are left out: shops sell both under those paths.
 */
export function isArticlePage(url: string): boolean {
  try {
    return new URL(url).pathname.split("/").some((segment) => ARTICLE_SEGMENT.test(segment));
  } catch {
    return false;
  }
}

/**
 * Whether a monitor gets the stock and price checks: its page is a product
 * page, or it is a listing in a product (one the user picked from a search).
 */
export function isProductMonitor(monitor: { schema?: unknown; groupId?: string; url: string }): boolean {
  return monitor.groupId !== undefined || productItem(monitor.schema, monitor.url) !== null;
}

/** Text kept before the title, for "Sold out" badges that sit above it. */
const EXCERPT_BEFORE = 200;
/**
 * Text kept from the title on: enough to reach the price and the buy button.
 * Kept short because the buy box also holds volatile text, such as delivery
 * countdowns, and every change inside the window pays for a re-read.
 */
const EXCERPT_AFTER = 700;
export const PRODUCT_EXCERPT_MAX = EXCERPT_BEFORE + EXCERPT_AFTER;

/**
 * Fold the characters a shop's page and the AI's copy of a title disagree on:
 * dash and quote variants, trademark marks and runs of whitespace.
 */
function normaliseForMatch(text: string): string {
  return text
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2122\u00AE\u00A9]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fewer title words than this could all sit in a navigation bar. */
const MIN_SPAN_WORDS = 3;

/**
 * Where every word of the title appears within a short span, for a shop that
 * words the title its own way: an extra word such as "AMD", or punctuation.
 * Words match whole, one-letter ones too, so "11" is not found inside
 * "$1,119" and "Series X" does not match "Series S". A span starts at the
 * title's first word and ends before its next one, so it cannot take words
 * from two neighbouring products. Empty when no span holds them all: a false
 * match is worse than none, because the caller then hashes the wrong slice.
 */
function wordsTogether(flat: string, needle: string): number[] {
  const words = needle
    .split(" ")
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean)
    .map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(w)}(?![\\p{L}\\p{N}])`, "iu"));
  if (words.length < MIN_SPAN_WORDS) return [];
  const span = needle.length * 2;
  const starts = [...flat.matchAll(new RegExp(words[0]!.source, "giu"))].map((hit) => hit.index);
  return starts.filter((start, i) => {
    const window = flat.slice(start, Math.min(start + span, starts[i + 1] ?? Infinity));
    return words.every((w) => w.test(window));
  });
}

/**
 * A price followed by text that is not more of it, so a window cut
 * mid-price ("$31" of "$319.00") does not count as holding one.
 */
const WHOLE_PRICE = /[$£€]\s?\d[\d,]*(\.\d\d)?(?=[.,]?[^\d.,])/;

/**
 * The part of a product page that describes the product.
 *
 * Most product pages change on most checks (ticket 01 measured a median of
 * two in three), from review counts and recommendation blocks well away from
 * the buy box. Hashing only this slice means that churn does not buy a
 * re-read. Link targets are dropped because tracking tokens in them change
 * on every load.
 *
 * When the title is not on the page, even as its words close together,
 * `matched` is false and the excerpt is
 * taken around the first price instead, or from the top of the page. The
 * caller should then re-read on any page change, so the alert still works.
 */
export function productExcerpt(text: string, title: string): { excerpt: string; matched: boolean } {
  const flat = normaliseForMatch(text.replace(/\]\([^)\s]*\)/g, "]"));
  const needle = normaliseForMatch(title);
  // A case-insensitive search on the string being sliced, so the index lines
  // up. Lowercasing a copy can change its length.
  const exact = needle ? [...flat.matchAll(new RegExp(escapeRegExp(needle), "gi"))].map((hit) => hit.index) : [];
  const mentions = exact.length > 0 ? exact : wordsTogether(flat, needle);
  // Shops repeat the title in breadcrumbs and review forms above the buy box.
  // The first mention whose window reaches a price is the buy box; failing
  // that, the first mention, as before.
  // A window that reaches the end of the page is not cut, so the page's last price counts.
  const holdsPrice = (m: number) => WHOLE_PRICE.test(m + EXCERPT_AFTER >= flat.length ? `${flat.slice(m)} ` : flat.slice(m, m + EXCERPT_AFTER));
  const at = mentions.find(holdsPrice) ?? mentions[0];
  if (at !== undefined) {
    return { excerpt: flat.slice(Math.max(0, at - EXCERPT_BEFORE), at + EXCERPT_AFTER).trim(), matched: true };
  }
  const price = Math.max(0, flat.search(/[$£€]\s?\d/));
  return { excerpt: flat.slice(Math.max(0, price - EXCERPT_BEFORE), price + EXCERPT_AFTER).trim(), matched: false };
}
