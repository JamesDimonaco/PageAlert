/**
 * A monitor watches one product when its last full read found exactly one
 * item. Only those get the stock check: on a listing page "is it in stock"
 * has no single answer.
 */
export function isSingleProduct(schema: unknown): boolean {
  const items = (schema as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(items) && items.length === 1;
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

/**
 * The part of a product page that describes the product.
 *
 * Most product pages change on most checks (ticket 01 measured a median of
 * two in three), from review counts and recommendation blocks well away from
 * the buy box. Hashing only this slice means that churn does not buy a
 * re-read. Link targets are dropped because tracking tokens in them change
 * on every load.
 *
 * When the title is not on the page, `matched` is false and the excerpt is
 * taken around the first price instead, or from the top of the page. The
 * caller should then re-read on any page change, so the alert still works.
 */
export function productExcerpt(text: string, title: string): { excerpt: string; matched: boolean } {
  const flat = normaliseForMatch(text.replace(/\]\([^)\s]*\)/g, "]"));
  const needle = normaliseForMatch(title);
  // A case-insensitive search on the string being sliced, so the index lines
  // up. Lowercasing a copy can change its length.
  const at = needle ? flat.search(new RegExp(escapeRegExp(needle), "i")) : -1;
  if (at !== -1) {
    return { excerpt: flat.slice(Math.max(0, at - EXCERPT_BEFORE), at + EXCERPT_AFTER).trim(), matched: true };
  }
  const price = Math.max(0, flat.search(/[$£€]\s?\d/));
  return { excerpt: flat.slice(Math.max(0, price - EXCERPT_BEFORE), price + EXCERPT_AFTER).trim(), matched: false };
}

/**
 * A price in the currency's minor units (pence, cents, yen), or null when it
 * cannot be read. Money is never stored as a float.
 *
 * The currency sets the scale: JPY has no minor unit and KWD has three, so a
 * fixed ×100 would be wrong by 100× or 10× on those.
 */
export function toMinorUnits(amount: unknown, currency: unknown): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  let digits: number;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return null;
  }
  // Rounded because 19.99 * 100 is 1998.9999999999998.
  return Math.round(amount * 10 ** digits);
}
