import { NextResponse } from "next/server";
import { after } from "next/server";
import { fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getToken, isAuthenticated } from "@/lib/auth-server";
import { logger } from "@/lib/server-logger";

// Room for a direct attempt and, if the site blocks it, one through the proxy.
export const maxDuration = 120;

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

  let body: { url: string; monitorId?: Id<"monitors"> };
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON: expected an object" }, { status: 400 });
    }
    body = parsed as { url: string; monitorId?: Id<"monitors"> };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  const domain = (() => { try { return new URL(body.url).hostname; } catch { return body.url; } })();

  try {
    logger.info("scrape: started", { url: domain });

    const res = await callScraper(scraperUrl, scraperKey, { url: body.url });

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

    if ((data as { blocked?: boolean }).blocked && body.monitorId) {
      const proxied = await retryThroughProxy(scraperUrl, scraperKey, body.monitorId);
      logger.info("scrape: blocked, proxy retry", { url: domain, ok: proxied !== null, duration_ms: Date.now() - startTime });
      after(() => logger.flush());
      return NextResponse.json(proxied ?? data);
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

function callScraper(scraperUrl: string, scraperKey: string, payload: { url: string; useProxy?: boolean }) {
  return fetch(`${scraperUrl}/api/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": scraperKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(55000),
  });
}

/**
 * The proxied page, or null to fall back to the direct result. Null covers
 * every failure on purpose: the blocked response already starts the
 * background retries, so a proxy that also fails costs the user nothing more.
 */
async function retryThroughProxy(
  scraperUrl: string,
  scraperKey: string,
  monitorId: Id<"monitors">
): Promise<Record<string, unknown> | null> {
  try {
    const token = await getToken();
    if (!token) return null;
    const url = await fetchMutation(api.monitors.claimFirstScanProxy, { id: monitorId }, { token });
    if (!url) return null;
    const res = await callScraper(scraperUrl, scraperKey, { url, useProxy: true });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    // Only a scraper predating useProxy answers blocked here: it ran a second
    // direct scrape instead, and that page must not be saved as a success.
    return data.blocked ? null : data;
  } catch {
    return null;
  }
}
