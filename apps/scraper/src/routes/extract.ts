import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { FALLBACK_PROVIDER_ERROR, scrapeUrl } from "../services/scraper.js";
import { extractWithAI } from "../services/extractor.js";
import { MAX_URL_LENGTH } from "../utils/url-validation.js";
import { hashContent } from "../utils/content-hash.js";

const extractSchema = z.object({
  url: z.string().url().max(MAX_URL_LENGTH),
  prompt: z.string().min(1).max(2000),
  name: z.string().max(200).optional(),
  timeout: z.number().int().min(1000).max(60000).optional(),
  retryAttempt: z.number().int().min(0).max(10).optional(),
  skipBlockCheck: z.boolean().optional(),
  useProxy: z.boolean().optional(),
});

export const extractRoutes = new Hono();

extractRoutes.post("/", zValidator("json", extractSchema), async (c) => {
  const { url, prompt, name, timeout, retryAttempt, skipBlockCheck, useProxy } = c.req.valid("json");

  try {
    const scraped = await scrapeUrl(url, { timeout, retryAttempt, useProxy });

    // Don't waste AI credits on anti-bot challenge pages — unless caller
    // explicitly skips (e.g., forced retry where we want the AI to try anyway)
    if (scraped.blocked && !skipBlockCheck) {
      const safeUrl = (() => { try { return new URL(url).hostname; } catch { return "[invalid]"; } })();
      console.warn(`[extract] Blocked by anti-bot for ${safeUrl}: ${scraped.blockReason}`);
      return c.json({
        error: "blocked",
        message: `Site is blocking automated access: ${scraped.blockReason ?? "anti-bot protection detected"}`,
      }, 403);
    }

    const { schema, matches } = await extractWithAI(scraped.text, prompt, url, name);

    return c.json({
      url,
      schema,
      matches,
      totalItems: schema.items.length,
      contentHash: hashContent(scraped.text),
      scrapedAt: scraped.scrapedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeUrl = (() => { try { return new URL(url).hostname; } catch { return "[invalid]"; } })();
    console.error(`[extract] Failed for ${safeUrl}:`, message);

    // Categorise the error for the client without leaking internals
    let clientMessage = "Extraction failed";
    let statusCode = 500;

    if (message.startsWith("Site is blocking automated access")) {
      // Same shape and status as the detected-block response above
      clientMessage = message;
      statusCode = 403;
    } else if (message.startsWith(FALLBACK_PROVIDER_ERROR)) {
      // Checked before the billing branch: Scrapfly's reason can say "credits"
      clientMessage = message;
      statusCode = 502;
    } else if (message.includes("URL") || message.includes("hostname") || message.includes("not allowed")) {
      clientMessage = message; // URL validation errors are safe to return
      statusCode = 400;
    } else if (message.includes("Could not resolve authentication") || message.includes("api_key")) {
      clientMessage = "AI service authentication error - check ANTHROPIC_API_KEY";
      console.error("[extract] Anthropic API key issue - is ANTHROPIC_API_KEY set correctly?");
    } else if (message.includes("credit") || message.includes("billing") || message.includes("insufficient")) {
      clientMessage = "AI service billing error - check Anthropic account credits";
    } else if (message.includes("rate_limit") || message.includes("429")) {
      clientMessage = "AI service rate limited - try again shortly";
      statusCode = 429;
    } else if (message.includes("timeout") || message.includes("Timeout")) {
      clientMessage = "Page took too long to load";
      statusCode = 504;
    } else if (message.includes("Too many concurrent")) {
      clientMessage = message;
      statusCode = 429;
    } else if (message.includes("JSON") || message.includes("parse")) {
      clientMessage = "AI returned invalid response - try a different prompt";
    } else if (typeof (error as { status?: unknown }).status === "number") {
      // Anthropic APIError from whichever SDK copy threw it. The PostHog
      // wrapper ships its own @anthropic-ai/sdk, so an instanceof check against
      // ours never matches in prod. A retired-model 404 used to land in the
      // generic "Extraction failed" bucket and hid a total outage for weeks —
      // always name the status so the next one is obvious from a log.
      clientMessage = `AI service error ${(error as { status: number }).status}: ${message}`;
    }

    return c.json({ error: "extract_failed", message: clientMessage }, statusCode as 400 | 403 | 429 | 500 | 502 | 504);
  }
});
