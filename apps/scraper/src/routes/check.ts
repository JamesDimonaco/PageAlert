import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { scrapeUrl } from "../services/scraper.js";
import { extractWithAI, applyMatchConditions } from "../services/extractor.js";
import { MAX_URL_LENGTH } from "../utils/url-validation.js";

const MAX_ITEMS = 500;
const MAX_STRING_ARRAY_ITEMS = 20;
const MAX_KEYWORD_LENGTH = 200;

const checkSchema = z.object({
  url: z.string().url().max(MAX_URL_LENGTH),
  schema: z.object({
    fields: z.record(z.string().max(500)).refine((r) => Object.keys(r).length <= 50, {
      message: "Too many fields (max 50)",
    }),
    items: z.array(z.record(z.any())).max(MAX_ITEMS),
    matchConditions: z.object({
      titleContains: z.array(z.string().max(MAX_KEYWORD_LENGTH)).max(MAX_STRING_ARRAY_ITEMS).optional(),
      titleExcludes: z.array(z.string().max(MAX_KEYWORD_LENGTH)).max(MAX_STRING_ARRAY_ITEMS).optional(),
      priceMax: z.number().min(0).max(1_000_000_000).optional(),
      priceMin: z.number().min(0).max(1_000_000_000).optional(),
      mustInclude: z.array(z.string().max(MAX_KEYWORD_LENGTH)).max(MAX_STRING_ARRAY_ITEMS).optional(),
      mustExclude: z.array(z.string().max(MAX_KEYWORD_LENGTH)).max(MAX_STRING_ARRAY_ITEMS).optional(),
    }),
  }),
  prompt: z.string().max(2000).optional(),
  timeout: z.number().int().min(1000).max(60000).optional(),
});

export const checkRoutes = new Hono();

checkRoutes.post("/", zValidator("json", checkSchema), async (c) => {
  const { url, schema, prompt, timeout } = c.req.valid("json");

  try {
    const scraped = await scrapeUrl(url, { timeout });

    // Re-extract items using AI to handle page structure changes
    const { schema: newSchema, matches } = await extractWithAI(
      scraped.text,
      prompt || `Extract items matching: ${JSON.stringify(schema.matchConditions)}`
    );

    // Also apply the original match conditions as a fallback
    const fallbackMatches = applyMatchConditions(newSchema.items, schema.matchConditions);

    // Use whichever found more matches (AI understanding vs strict conditions)
    const finalMatches = matches.length >= fallbackMatches.length ? matches : fallbackMatches;

    return c.json({
      url,
      matches: finalMatches,
      totalItems: newSchema.items.length,
      hasNewMatches: finalMatches.length > 0,
      scrapedAt: scraped.scrapedAt,
    });
  } catch (error) {
    // Do not leak internal error details
    return c.json({ error: "check_failed", message: "Check failed" }, 500);
  }
});
