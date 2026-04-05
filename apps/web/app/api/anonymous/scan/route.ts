import { NextResponse } from "next/server";
import { after } from "next/server";
import { logger } from "@/lib/server-logger";
import { createHash } from "crypto";
import { resolve4, resolve6 } from "dns/promises";

export const maxDuration = 120;

// Simple in-memory IP rate limiting (resets on deploy)
const ipRequests = new Map<string, number>();

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

/** Hash IP for logging — never log raw IPs */
function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 12);
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;

  // Clean old entries periodically
  if (ipRequests.size > 1000) {
    for (const [key, time] of ipRequests) {
      if (time < hourAgo) ipRequests.delete(key);
    }
  }

  const lastRequest = ipRequests.get(ip);
  return !!(lastRequest && lastRequest > hourAgo);
}

function recordRequest(ip: string): void {
  ipRequests.set(ip, Date.now());
}

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

export async function POST(request: Request) {
  const startTime = Date.now();
  const ip = getClientIp(request);
  const ipHash = hashIp(ip);

  // IP rate limit: 1 anonymous scan per hour per IP
  if (isRateLimited(ip)) {
    logger.warn("anonymous-scan: rate limited", { ip: ipHash });
    after(() => logger.flush());
    return NextResponse.json(
      { error: "You can try one free scan per hour. Create a free account for unlimited scans!" },
      { status: 429 }
    );
  }

  const scraperUrl = process.env.SCRAPER_URL;
  const scraperKey = process.env.SCRAPER_API_KEY;

  if (!scraperUrl || !scraperKey) {
    return NextResponse.json({ error: "Scraper not configured" }, { status: 503 });
  }

  let body: { url: string; prompt: string; name?: string };
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    body = parsed as { url: string; prompt: string; name?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.url || !body.prompt) {
    return NextResponse.json({ error: "URL and prompt are required" }, { status: 400 });
  }

  // URL validation + SSRF protection
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(body.url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return NextResponse.json({ error: "Only http/https URLs are allowed" }, { status: 400 });
    }
    const hostname = parsedUrl.hostname.toLowerCase();
    const blocked = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "metadata.google.internal", "169.254.169.254"];
    if (blocked.includes(hostname) || !hostname.includes(".")) {
      return NextResponse.json({ error: "This URL is not allowed" }, { status: 400 });
    }
    const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a === 127 || (a === 169 && b === 254) || a === 0) {
        return NextResponse.json({ error: "This URL is not allowed" }, { status: 400 });
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
        return NextResponse.json({ error: "This URL is not allowed" }, { status: 400 });
      }
    }
    // DNS-based SSRF check: resolve hostname and reject private IPs
    if (!(await isHostAllowed(hostname))) {
      return NextResponse.json({ error: "This URL is not allowed" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  const domain = parsedUrl.hostname;

  try {
    logger.info("anonymous-scan: started", { ip: ipHash, url: domain, prompt_length: body.prompt.length });

    const res = await fetch(`${scraperUrl}/api/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": scraperKey,
      },
      body: JSON.stringify({ url: body.url, prompt: body.prompt, name: body.name }),
      signal: AbortSignal.timeout(110000),
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      logger.error("anonymous-scan: invalid JSON from scraper", { url: domain });
      after(() => logger.flush());
      return NextResponse.json({ error: "Scan failed — invalid response" }, { status: 502 });
    }

    const durationMs = Date.now() - startTime;

    if (!res.ok) {
      const errorMsg = (data as Record<string, unknown>)?.error ?? "Scan failed";
      logger.error("anonymous-scan: scraper error", { url: domain, status: res.status, error: String(errorMsg), duration_ms: durationMs });
      after(() => logger.flush());
      const clientStatus = res.status >= 400 && res.status < 500 ? 400 : 502;
      return NextResponse.json({ error: String(errorMsg) }, { status: clientStatus });
    }

    // Only consume the rate limit quota on successful scans
    recordRequest(ip);

    const d = data as Record<string, unknown>;
    logger.info("anonymous-scan: completed", {
      ip: ipHash,
      url: domain,
      duration_ms: durationMs,
      items: Number(d.totalItems ?? 0),
      matches: Array.isArray(d.matches) ? d.matches.length : 0,
      type: "anonymous",
    });
    after(() => logger.flush());

    return NextResponse.json(data);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "Scan timed out — try a simpler page"
        : "Failed to reach scraper";
    logger.error("anonymous-scan: failed", { url: domain, error: message, duration_ms: durationMs });
    after(() => logger.flush());
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
