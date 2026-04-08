import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { scrapeUrl } from "../services/scraper.js";
import { extractWithAI } from "../services/extractor.js";
import { MAX_URL_LENGTH } from "../utils/url-validation.js";

const extractSchema = z.object({
  url: z.string().url().max(MAX_URL_LENGTH),
  prompt: z.string().min(1).max(2000),
  name: z.string().max(200).optional(),
  timeout: z.number().int().min(1000).max(60000).optional(),
  retryAttempt: z.number().int().min(0).max(10).optional(),
  skipBlockCheck: z.boolean().optional(),
});

export const extractRoutes = new Hono();

extractRoutes.post("/", zValidator("json", extractSchema), async (c) => {
  const { url, prompt, name, timeout, retryAttempt, skipBlockCheck } = c.req.valid("json");

  try {
    const scraped = await scrapeUrl(url, { timeout, retryAttempt });

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
      scrapedAt: scraped.scrapedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeUrl = (() => { try { return new URL(url).hostname; } catch { return "[invalid]"; } })();
    console.error(`[extract] Failed for ${safeUrl}:`, message);

    // Categorise the error for the client without leaking internals
    let clientMessage = "Extraction failed";
    let statusCode = 500;

    if (message.includes("URL") || message.includes("hostname") || message.includes("not allowed")) {
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
    }

    return c.json({ error: "extract_failed", message: clientMessage }, statusCode);
  }
});
