import { NextResponse } from "next/server";
import { after } from "next/server";
import { isAuthenticated } from "@/lib/auth-server";
import { logger } from "@/lib/server-logger";

export const maxDuration = 60;

/**
 * Proxy to the scraper's /api/scrape endpoint — scrapes the page with
 * Playwright and returns cleaned HTML/text without running AI extraction.
 *
 * Used by the split scan flow (PROWL-039 Part 1) so the client can show
 * real progress: scrape → extract as two sequential steps.
 */
export async function POST(request: Request) {
  const startTime = Date.now();

  const authed = await isAuthenticated();
  if (!authed) {
    logger.warn("scrape: unauthenticated request");
    after(() => logger.flush());
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const scraperUrl = process.env.SCRAPER_URL;
  const scraperKey = process.env.SCRAPER_API_KEY;

  if (!scraperUrl || !scraperKey) {
    logger.error("scrape: scraper not configured");
    after(() => logger.flush());
    return NextResponse.json(
      { error: "Scraper not configured" },
      { status: 503 }
    );
  }

  let body: { url: string };
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON: expected an object" }, { status: 400 });
    }
    body = parsed as { url: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  const domain = (() => { try { return new URL(body.url).hostname; } catch { return body.url; } })();

  try {
    logger.info("scrape: started", { url: domain });

    const res = await fetch(`${scraperUrl}/api/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": scraperKey,
      },
      body: JSON.stringify({ url: body.url }),
      signal: AbortSignal.timeout(55000),
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      logger.error("scrape: invalid JSON from scraper", { url: domain, status: res.status });
      after(() => logger.flush());
      return NextResponse.json({ error: text }, { status: res.status });
    }

    const durationMs = Date.now() - startTime;

    if (!res.ok) {
      const errorMsg = (data as Record<string, unknown>)?.error ?? "Unknown error";
      logger.error("scrape: error", { url: domain, status: res.status, error: String(errorMsg), duration_ms: durationMs });
      after(() => logger.flush());
      return NextResponse.json(data, { status: res.status });
    }

    logger.info("scrape: completed", { url: domain, duration_ms: durationMs });
    after(() => logger.flush());
    return NextResponse.json(data);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "Scraper timed out"
        : "Failed to reach scraper";
    logger.error("scrape: failed", { url: domain, error: message, duration_ms: durationMs });
    after(() => logger.flush());
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
