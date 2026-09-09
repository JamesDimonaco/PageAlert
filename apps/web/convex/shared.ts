/** Maximum retry attempts before marking a monitor as error */
export const MAX_RETRIES = 3;

/**
 * Confirmed Scrapfly blocks (proxy, asp=true) before a monitor stops being
 * rescheduled entirely. Scrapfly is the specialist for anti-bot pages — if it
 * gets blocked this many times, the site has genuinely beaten it and further
 * 6-hourly attempts are pure spend.
 *
 * Only blocks on the recovery lane count (see confirmedProxyBlock in
 * scheduler.ts), so these are ERROR_RECOVERY_INTERVAL_MS apart. Counting the
 * fast 2min/8min ladder instead would park a live monitor inside one
 * Cloudflare spike.
 */
export const MAX_PROXY_BLOCKS = 2;

/**
 * How often an errored monitor retries. Slow enough not to burn scrapes on a
 * permanently dead URL, fast enough to self-heal within a day of a fix.
 */
export const ERROR_RECOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How often a proxy-preferred monitor tries direct again. Without this a site
 * that drops its anti-bot protection keeps costing Scrapfly credits forever.
 * One wasted check in 20 is a cheap price for noticing.
 */
export const PROXY_REPROBE_EVERY = 20;

/** One classifier for "the site refused us" across scheduler, scan errors, and operator tooling. */
export function isBlockedError(message: string): boolean {
  return /blocking automated access|anti-bot|CAPTCHA|Cloudflare|Access denied|blocked/i.test(message);
}

/**
 * Identity of a matched item, for deciding whether a match is new.
 *
 * Deliberately not `getItemKey` from @prowl/shared, which falls back to
 * `title-price`. That key exists so the blacklist can pin an exact listing;
 * here a price move on the same product must not read as a new match, or every
 * repricing would email the user. Price changes have their own alert path.
 */
export function matchKey(item: Record<string, unknown>): string {
  const url = item.url ? String(item.url).trim() : "";
  if (url) return url;
  return String(item.title ?? item.name ?? "").trim().toLowerCase();
}

/**
 * Keys present now that were not present last time.
 *
 * `previous` being undefined means this monitor has no baseline yet — it
 * predates match tracking, or this is its first extract. Returning nothing
 * seeds the baseline silently instead of announcing every existing match as
 * new, which would have emailed half the fleet the moment this shipped.
 */
export function newMatchKeys(
  previous: string[] | undefined,
  current: string[]
): string[] {
  if (previous === undefined) return [];
  const seen = new Set(previous);
  return [...new Set(current.filter((k) => k && !seen.has(k)))];
}

/** Hostname without www., or the raw string if it does not parse. */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const BLOCKED_HOSTS = [
  "localhost", "127.0.0.1", "0.0.0.0", "[::1]",
  "metadata.google.internal", "169.254.169.254",
];

/**
 * Validate a monitor URL: checks length, protocol, blocked hosts,
 * private IP ranges, and FQDN requirement. Throws on failure.
 * Returns the parsed URL on success.
 */
export function validateMonitorUrl(url: string, maxLength = 2048): URL {
  if (url.length > maxLength) {
    throw new Error(`URL exceeds maximum length of ${maxLength} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.includes(hostname)) {
    throw new Error("This hostname is not allowed");
  }
  const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a === 127 || (a === 169 && b === 254) || a === 0) {
      throw new Error("URLs pointing to private/internal IP addresses are not allowed");
    }
  }
  // Block IPv6 private/link-local/loopback ranges (fc00::/7, fe80::/10, ::1, ::ffff-mapped private)
  const ipv6Match = hostname.match(/^\[([a-f0-9:]+(?:\.\d+)*)\]$/i);
  if (ipv6Match) {
    const addr = ipv6Match[1]!.toLowerCase();
    if (
      addr === "::1" ||
      addr === "::" ||
      addr.startsWith("fc") ||
      addr.startsWith("fd") ||
      addr.startsWith("fe80") ||
      addr.startsWith("::ffff:127.") ||
      addr.startsWith("::ffff:10.") ||
      addr.startsWith("::ffff:192.168.") ||
      addr.startsWith("::ffff:0.")
    ) {
      throw new Error("URLs pointing to private/internal IP addresses are not allowed");
    }
  }
  if (!hostname.includes(".")) {
    throw new Error("URL must use a fully qualified domain name");
  }
  return parsed;
}

/** Convert a check interval string to milliseconds */
export function intervalToMs(interval: string): number {
  const map: Record<string, number> = {
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
    "1h": 60 * 60_000,
    "6h": 6 * 60 * 60_000,
    "24h": 24 * 60 * 60_000,
  };
  return map[interval] ?? 60 * 60_000;
}
