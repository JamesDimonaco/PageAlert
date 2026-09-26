import { NextResponse } from "next/server";
import { after } from "next/server";
import { logger } from "@/lib/server-logger";
import { createHash } from "crypto";
import { extractPage, urlRejection } from "@/lib/scraper-server";

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

  const rejection = await urlRejection(body.url);
  if (rejection) {
    return NextResponse.json({ error: rejection }, { status: 400 });
  }

  const domain = new URL(body.url).hostname;

  logger.info("anonymous-scan: started", { ip: ipHash, url: domain, prompt_length: body.prompt.length });
  const outcome = await extractPage({ url: body.url, prompt: body.prompt, name: body.name });
  const durationMs = Date.now() - startTime;

  if (!outcome.ok) {
    logger.error("anonymous-scan: failed", { url: domain, error: outcome.error, duration_ms: durationMs });
    after(() => logger.flush());
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }

  // Only consume the rate limit quota on successful scans
  recordRequest(ip);

  logger.info("anonymous-scan: completed", {
    ip: ipHash,
    url: domain,
    duration_ms: durationMs,
    items: Number(outcome.data.totalItems ?? 0),
    matches: Array.isArray(outcome.data.matches) ? outcome.data.matches.length : 0,
    type: "anonymous",
  });
  after(() => logger.flush());

  return NextResponse.json(outcome.data);
}
