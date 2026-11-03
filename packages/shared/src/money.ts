/**
 * Digits after the decimal point for an ISO 4217 currency: 2 for GBP, 0 for
 * JPY, 3 for KWD. Null for a code Intl does not know.
 */
export function currencyExponent(currency: string): number | null {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? null;
  } catch {
    return null;
  }
}

/** A price as read (12.99) to integer minor units (1299). Null if either is unusable. */
export function toMinorUnits(amount: number, currency: string): number | null {
  const exponent = currencyExponent(currency);
  if (exponent === null || !Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 10 ** exponent);
}
