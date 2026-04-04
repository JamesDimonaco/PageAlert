import { NextResponse } from "next/server";
import { after } from "next/server";
import { logger } from "@/lib/server-logger";

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
  if (lastRequest && lastRequest > hourAgo) {
    return true; // Already scanned in the last hour
  }

  ipRequests.set(ip, now);
  return false;
}

export async function POST(request: Request) {
  const startTime = Date.now();
  const ip = getClientIp(request);

  // IP rate limit: 1 anonymous scan per hour per IP
  if (isRateLimited(ip)) {
    logger.warn("anonymous-scan: rate limited", { ip });
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
  try {
    const parsed = new URL(body.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return NextResponse.json({ error: "Only http/https URLs are allowed" }, { status: 400 });
    }
    const hostname = parsed.hostname.toLowerCase();
    const blocked = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "metadata.google.internal", "169.254.169.254"];
    if (blocked.includes(hostname) || !hostname.includes(".")) {
      return NextResponse.json({ error: "This URL is not allowed" }, { status: 400 });
    }
    const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a === 127 || a === 0) {
        return NextResponse.json({ error: "This URL is not allowed" }, { status: 400 });
      }
    }
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  const domain = (() => { try { return new URL(body.url).hostname; } catch { return body.url; } })();

  try {
    logger.info("anonymous-scan: started", { ip, url: domain, prompt_length: body.prompt.length });

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
      return NextResponse.json({ error: String(errorMsg) }, { status: res.status });
    }

    const d = data as Record<string, unknown>;
    logger.info("anonymous-scan: completed", {
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
