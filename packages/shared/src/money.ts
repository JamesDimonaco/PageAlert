let knownCurrencies: Set<string> | undefined;

/**
 * Digits after the decimal point for an ISO 4217 currency: 2 for GBP, 0 for
 * JPY, 3 for KWD. Null for a code that is not a real currency, such as "UKP"
 * or "RMB": Intl formats any three letters, so it is checked against the list.
 */
export function currencyExponent(currency: string): number | null {
  knownCurrencies ??= new Set(Intl.supportedValuesOf("currency"));
  if (!knownCurrencies.has(currency)) return null;
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? null;
}

/** A price as read (12.99) to integer minor units (1299). Null if either is unusable. */
export function toMinorUnits(amount: number, currency: string): number | null {
  const exponent = currencyExponent(currency);
  if (exponent === null || !Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 10 ** exponent);
}
