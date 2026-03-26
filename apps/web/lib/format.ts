const formatters = new Map<string, Intl.NumberFormat>();

function getFormatter(currency: string): Intl.NumberFormat {
  const key = currency.toUpperCase();
  if (!formatters.has(key)) {
    try {
      formatters.set(key, new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: key,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }));
    } catch {
      // Invalid currency code — fall back to USD
      return getFormatter("USD");
    }
  }
  return formatters.get(key)!;
}

/** Safely format a price value with optional currency. Returns formatted string or null. */
export function formatPrice(value: unknown, currency?: unknown): string | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isFinite(num)) return null;
  const cur = typeof currency === "string" && currency.length === 3 ? currency : "USD";
  return getFormatter(cur).format(num);
}

/** Validate a URL is safe for use in href attributes. Returns the URL or null. */
export function toSafeUrl(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch { /* invalid */ }
  return null;
}
