import { resolve4, resolve6 } from "dns/promises";
import type { ExtractedItem, ExtractionSchema } from "@prowl/shared";

/** Server-side calls to the scraper, for routes that scan without a browser in the loop. */

export type ExtractResponse = {
  schema: ExtractionSchema;
  matches: ExtractedItem[];
  totalItems: number;
  contentHash?: string;
};

export type ExtractOutcome =
  | { ok: true; data: ExtractResponse }
  // status is what to send our own client: 400 when the scraper blamed the
  // request, 502 when it or the page failed.
  | { ok: false; error: string; status: 400 | 502 | 503 };

/** Resolve hostname and reject private/internal IPs */
async function isHostAllowed(hostname: string): Promise<boolean> {
  const addresses: string[] = [];
  try {
    const [ipv4, ipv6] = await Promise.allSettled([
      resolve4(hostname),
      resolve6(hostname),
    ]);
    if (ipv4.status === "fulfilled") addresses.push(...ipv4.value);
    if (ipv6.status === "fulfilled") addresses.push(...ipv6.value);
  } catch {
    // DNS resolution failed — allow through (scraper will fail naturally)
    return true;
  }

  for (const addr of addresses) {
    // IPv6 loopback
    if (addr === "::1" || addr === "::") return false;

    const parts = addr.split(".").map(Number);
    if (parts.length === 4) {
      const [a, b] = parts;
      if (
        a === 127 ||                                    // loopback
        a === 10 ||                                     // 10.0.0.0/8
        (a === 172 && b! >= 16 && b! <= 31) ||          // 172.16.0.0/12
        (a === 192 && b === 168) ||                     // 192.168.0.0/16
        (a === 169 && b === 254) ||                     // link-local / metadata
        a === 0                                         // 0.0.0.0/8
      ) {
        return false;
      }
    }
  }

  return true;
}

/** Why this URL may not be scanned, or null if it may. Includes the DNS-based SSRF check. */
export async function urlRejection(url: string): Promise<string | null> {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return "Only http/https URLs are allowed";
    }
    const hostname = parsedUrl.hostname.toLowerCase();
    const blocked = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "metadata.google.internal", "169.254.169.254"];
    if (blocked.includes(hostname) || !hostname.includes(".")) {
      return "This URL is not allowed";
    }
    const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a === 127 || (a === 169 && b === 254) || a === 0) {
        return "This URL is not allowed";
      }
    }
    // Block IPv6 private/link-local/loopback ranges
    const ipv6Match = hostname.match(/^\[([a-f0-9:]+(?:\.\d+)*)\]$/i);
    if (ipv6Match) {
      const addr = ipv6Match[1]!.toLowerCase();
      if (
        addr === "::1" || addr === "::" ||
        addr.startsWith("fc") || addr.startsWith("fd") || addr.startsWith("fe80") ||
        addr.startsWith("::ffff:127.") || addr.startsWith("::ffff:10.") ||
        addr.startsWith("::ffff:192.168.") || addr.startsWith("::ffff:0.")
      ) {
        return "This URL is not allowed";
      }
    }
    if (!(await isHostAllowed(hostname))) {
      return "This URL is not allowed";
    }
  } catch {
    return "Invalid URL";
  }
  return null;
}

/** Scrape and extract in one scraper call. Run urlRejection first. */
export async function extractPage(
  body: { url: string; prompt: string; name?: string },
  timeoutMs = 110_000
): Promise<ExtractOutcome> {
  const scraperUrl = process.env.SCRAPER_URL;
  const scraperKey = process.env.SCRAPER_API_KEY;
  if (!scraperUrl || !scraperKey) return { ok: false, error: "Scraper not configured", status: 503 };

  try {
    const res = await fetch(`${scraperUrl}/api/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": scraperKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: "Scan failed — invalid response", status: 502 };
    }

    if (!res.ok) {
      const d = data as Record<string, unknown>;
      // The scraper's `error` is a code ("blocked"); `message` is the readable reason.
      const errorMsg = d?.message ?? d?.error ?? "Scan failed";
      return { ok: false, error: String(errorMsg), status: res.status >= 400 && res.status < 500 ? 400 : 502 };
    }

    return { ok: true, data: data as ExtractResponse };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "Scan timed out — try a simpler page"
        : "Failed to reach scraper";
    return { ok: false, error: message, status: 502 };
  }
}
