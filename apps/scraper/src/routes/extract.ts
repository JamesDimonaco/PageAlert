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
    // Do not leak internal error details (e.g., Anthropic API errors, stack traces)
    return c.json({ error: "extract_failed", message: "Extraction failed" }, 500);
  }
});
