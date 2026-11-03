let knownCurrencies: Set<string> | undefined;
const formatters = new Map<string, Intl.NumberFormat>();

/** One formatter per real currency, or null for a code that is not one. */
function formatterFor(currency: string): Intl.NumberFormat | null {
  knownCurrencies ??= new Set(Intl.supportedValuesOf("currency"));
  if (!knownCurrencies.has(currency)) return null;
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
    formatters.set(currency, formatter);
  }
  return formatter;
}

/**
 * Digits after the decimal point for an ISO 4217 currency: 2 for GBP, 0 for
 * JPY, 3 for KWD. Null for a code that is not a real currency, such as "UKP"
 * or "RMB": Intl formats any three letters, so it is checked against the list.
 */
export function currencyExponent(currency: string): number | null {
  return formatterFor(currency)?.resolvedOptions().maximumFractionDigits ?? null;
}

/**
 * Format an integer minor-unit price (1299, "GBP") as "£12.99". Null for an
 * unknown currency, where showing dollars would be a wrong price.
 */
export function formatMinorUnits(minor: number, currency: string): string | null {
  const formatter = formatterFor(currency);
  const exponent = formatter?.resolvedOptions().maximumFractionDigits;
  if (!formatter || exponent === undefined) return null;
  return formatter.format(minor / 10 ** exponent);
}

/** A price as read (12.99) to integer minor units (1299). Null if either is unusable. */
export function toMinorUnits(amount: number, currency: string): number | null {
  const exponent = currencyExponent(currency);
  if (exponent === null || !Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 10 ** exponent);
}

/** Integer minor units (1299) back to the amount as written (12.99). Null for an unknown currency. */
export function fromMinorUnits(minor: number, currency: string): number | null {
  const exponent = currencyExponent(currency);
  return exponent === null ? null : minor / 10 ** exponent;
}
