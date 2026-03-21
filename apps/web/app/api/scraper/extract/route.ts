import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth-server";

export const maxDuration = 60;

export async function POST(request: Request) {
  // Verify the caller has a valid session before proxying to the scraper
  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const scraperUrl = process.env.SCRAPER_URL;
  const scraperKey = process.env.SCRAPER_API_KEY;

  if (!scraperUrl || !scraperKey) {
    return NextResponse.json(
      { error: "Scraper not configured" },
      { status: 503 }
    );
  }

  let body: { url: string; prompt: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.url || !body.prompt) {
    return NextResponse.json(
      { error: "url and prompt are required" },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(`${scraperUrl}/api/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": scraperKey,
      },
      body: JSON.stringify({ url: body.url, prompt: body.prompt }),
      signal: AbortSignal.timeout(55000),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "Scraper timed out"
        : "Failed to reach scraper";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
