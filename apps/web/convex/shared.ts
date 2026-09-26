import { canonicalUrl, DAY_MS } from "@prowl/shared";

export { MATCH_SCORE_THRESHOLD, alertsOnScore, matchConfidence, MATCH_CONFIDENCE_LABEL, canonicalUrl } from "@prowl/shared";

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
 * Consecutive failures before a monitor that has never once succeeded stops
 * being rescheduled.
 *
 * A monitor that has never worked was set up wrong — a dead URL, a page we
 * cannot read, a prompt matching nothing. Unlike a monitor that worked and
 * broke, there is no outage for it to recover from, so the 6h recovery lane
 * just bills forever. Eight of them were doing exactly that, at 40 to 52
 * failures each, and together with the rest of the error lane accounted for
 * 18% of all scans.
 *
 * 32 sits beyond anything that has ever come good: across six months of prod
 * the worst monitor to eventually succeed needed 30 failures first, and every
 * other one managed it inside 9. Deliberately generous — a monitor that has
 * worked even once is exempt by construction (checkCount counts successes
 * only), so this never decides anything for a working monitor.
 *
 * Counted in `retryCount`. A success resets it, and so do the manual retry
 * paths (monitors.ts saveScanError, admin.ts rerunNeverScanned), which rewrite
 * it to a small number. So pressing Retry on a parked monitor deliberately
 * buys it the better part of another budget — an explicit "I have fixed it,
 * try again" is worth more than a scheduled attempt.
 */
export const MAX_NEVER_SUCCEEDED_RETRIES = 32;

/**
 * The longest a monitor that has never been read keeps retrying before it
 * parks. The fast ladder ends at MAX_RETRIES; every failure after that is
 * ERROR_RECOVERY_INTERVAL_MS apart until MAX_NEVER_SUCCEEDED_RETRIES. A ceiling,
 * not a promise: a site that also refuses our proxy parks after
 * MAX_PROXY_BLOCKS recovery-lane attempts, about half a day. The
 * blocked-first-scan toast quotes it as "up to", which holds either way, and
 * both parks send the email that toast mentions.
 */
export const NEVER_SUCCEEDED_RETRY_DAYS = Math.round(
  ((MAX_NEVER_SUCCEEDED_RETRIES - MAX_RETRIES) * ERROR_RECOVERY_INTERVAL_MS) / DAY_MS,
);

/**
 * Why a monitor stopped being rescheduled, in the user's words. Set as
 * `lastError` at the park and passed to the stopped-checks alerts, so the
 * email, Telegram, Discord, push and in-app copies cannot drift apart or
 * describe the wrong park — see the park branches in scheduler.ts.
 */
export const PARK_REASON_PROXY_BLOCKED =
  "This site blocks automated access even through our proxy, so every attempt was turned away.";
export const PARK_REASON_NEVER_SUCCEEDED =
  "We have never managed to read this page since you set the monitor up, so it is worth checking the URL and the prompt.";

/**
 * How often a proxy-preferred monitor tries direct again. Without this a site
 * that drops its anti-bot protection keeps costing Scrapfly credits forever.
 *
 * Counted in checks, and proxy-preferred monitors are floored at
 * PROXY_MIN_INTERVAL_MS, so this is really "every N x 6 hours". At 20 that was
 * five days of paying Scrapfly for a site that may have dropped its WAF on day
 * one; 8 brings it back to about two.
 */
export const PROXY_REPROBE_EVERY = 8;

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
export function matchKey(item: { url?: unknown; title?: unknown; name?: unknown }): string {
  const url = item.url ? String(item.url).trim() : "";
  // Canonical, not raw: Amazon stamps a timestamp and a per-request token on
  // every product link, so the raw URL made one unchanged listing a new
  // arrival on every single check.
  if (url) return canonicalUrl(url);
  const title = String(item.title ?? item.name ?? "").trim().toLowerCase();
  if (title) return title;
  // An AI schema is free to produce items with neither a url nor a title —
  // {description, price}, say. Falling through to "" there would make every key
  // empty, so newMatchKeys would filter them all out and the monitor would
  // never alert again. Hash the item instead: stable for an unchanged item,
  // different for a new one, which is all the diff needs.
  return `#${hash(JSON.stringify(item))}`;
}

/** FNV-1a. Short, synchronous, and good enough to tell two items apart. */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
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
  // Baselines recorded before keys were canonicalised hold raw URLs. Counting
  // both forms as seen means the switch costs nobody a repeat alert for
  // everything already on their page; the next write stores canonical only.
  const seen = new Set<string>();
  for (const key of previous) {
    seen.add(key);
    seen.add(canonicalUrl(key));
  }
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

/**
 * Slowest cadence a site that only answers through the proxy is allowed to
 * run at. Every check on such a monitor spends a Scrapfly call, so an hourly
 * one burns the monthly budget six times faster than a six-hourly one — and
 * that budget is shared, so a handful of blocked sites can starve escalation
 * for everyone. A site earns its way back off via PROXY_REPROBE_EVERY.
 */
export const PROXY_MIN_INTERVAL_MS = 6 * 60 * 60_000;

/** How long until this monitor's next check, with the proxy floor applied */
export function effectiveIntervalMs(monitor: {
  checkInterval: string;
  proxyPreferred?: boolean;
}): number {
  const base = intervalToMs(monitor.checkInterval);
  return monitor.proxyPreferred === true ? Math.max(base, PROXY_MIN_INTERVAL_MS) : base;
}
