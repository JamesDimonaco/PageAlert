import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { scrapeUrl } from "../services/scraper.js";
import { extractWithAI } from "../services/extractor.js";
import { MAX_URL_LENGTH } from "../utils/url-validation.js";

const extractSchema = z.object({
  url: z.string().url().max(MAX_URL_LENGTH),
  prompt: z.string().min(1).max(2000),
  timeout: z.number().int().min(1000).max(60000).optional(),
});

export const extractRoutes = new Hono();

extractRoutes.post("/", zValidator("json", extractSchema), async (c) => {
  const { url, prompt, timeout } = c.req.valid("json");

  try {
    const scraped = await scrapeUrl(url, { timeout });
    const { schema, matches } = await extractWithAI(scraped.text, prompt);

    return c.json({
      url,
      schema,
      matches,
      totalItems: schema.items.length,
      scrapedAt: scraped.scrapedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[extract] Failed for ${url}:`, message);

    // Categorise the error for the client without leaking internals
    let clientMessage = "Extraction failed";
    let statusCode = 500;

    if (message.includes("URL") || message.includes("hostname") || message.includes("not allowed")) {
      clientMessage = message; // URL validation errors are safe to return
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
