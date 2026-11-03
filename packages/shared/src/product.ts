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
/** Text kept from the title on — enough to reach the price and buy button. */
const EXCERPT_AFTER = 2000;
export const PRODUCT_EXCERPT_MAX = EXCERPT_BEFORE + EXCERPT_AFTER;

/**
 * The part of a product page that describes the product, or null when the
 * title is not on the page.
 *
 * Most product pages change on most checks (ticket 01 measured a median of
 * two in three), from review counts and recommendation blocks well away from
 * the buy box. Hashing only this slice means that churn does not buy a
 * re-score. Link targets are dropped because tracking tokens in them change
 * on every load.
 */
export function productExcerpt(text: string, title: string): string | null {
  const needle = title.replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) return null;
  const flat = text.replace(/\]\([^)\s]*\)/g, "]").replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(needle);
  if (at === -1) return null;
  return flat.slice(Math.max(0, at - EXCERPT_BEFORE), at + EXCERPT_AFTER).trim();
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
