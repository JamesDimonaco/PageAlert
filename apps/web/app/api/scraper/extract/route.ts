import { NextResponse } from "next/server";
import { after } from "next/server";
import { isAuthenticated } from "@/lib/auth-server";
import { logger } from "@/lib/server-logger";

export const maxDuration = 120;

export async function POST(request: Request) {
  const startTime = Date.now();

  // Verify the caller has a valid session before proxying to the scraper
  const authed = await isAuthenticated();
  if (!authed) {
    logger.warn("extract: unauthenticated request");
    after(() => logger.flush());
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const scraperUrl = process.env.SCRAPER_URL;
  const scraperKey = process.env.SCRAPER_API_KEY;

  if (!scraperUrl || !scraperKey) {
    logger.error("extract: scraper not configured");
    after(() => logger.flush());
    return NextResponse.json(
      { error: "Scraper not configured" },
      { status: 503 }
    );
  }

  let body: { url: string; prompt: string; name?: string };
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON: expected an object" }, { status: 400 });
    }
    body = parsed as { url: string; prompt: string; name?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.url || !body.prompt) {
    return NextResponse.json(
      { error: "url and prompt are required" },
      { status: 400 }
    );
  }

  const domain = (() => { try { return new URL(body.url).hostname; } catch { return body.url; } })();

  try {
    logger.info("extract: started", { url: domain, prompt_length: body.prompt.length });

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
      logger.error("extract: invalid JSON from scraper", { url: domain, status: res.status });
      after(() => logger.flush());
      return NextResponse.json({ error: text }, { status: res.status });
    }

    const durationMs = Date.now() - startTime;

    if (!res.ok) {
      const errorMsg = (data as Record<string, unknown>)?.error ?? "Unknown error";
      logger.error("extract: scraper error", { url: domain, status: res.status, error: String(errorMsg), duration_ms: durationMs });
      after(() => logger.flush());
      return NextResponse.json(data, { status: res.status });
    }

    const d = data as Record<string, unknown>;
    logger.info("extract: completed", {
      url: domain,
      status: res.status,
      duration_ms: durationMs,
      items: Number(d.totalItems ?? 0),
      matches: Array.isArray(d.matches) ? d.matches.length : 0,
    });
    after(() => logger.flush());
    return NextResponse.json(data);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "Scraper timed out"
        : "Failed to reach scraper";
    logger.error("extract: failed", { url: domain, error: message, duration_ms: durationMs });
    after(() => logger.flush());
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
