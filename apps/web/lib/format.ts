/** Safely format a price value. Returns formatted string or null if not a valid number. */
export function formatPrice(value: unknown): string | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isFinite(num)) return null;
  return `$${num.toLocaleString()}`;
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
