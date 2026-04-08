import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { scrapeUrl } from "../services/scraper.js";
import { MAX_URL_LENGTH } from "../utils/url-validation.js";

const MAX_KEYWORD_LENGTH = 200;
const MAX_STRING_ARRAY_ITEMS = 20;

const quickCheckSchema = z.object({
  url: z.string().url().max(MAX_URL_LENGTH),
  matchConditions: z.object({
    mustInclude: z.array(z.string().max(MAX_KEYWORD_LENGTH)).max(MAX_STRING_ARRAY_ITEMS).optional(),
    mustExclude: z.array(z.string().max(MAX_KEYWORD_LENGTH)).max(MAX_STRING_ARRAY_ITEMS).optional(),
    priceMin: z.number().min(0).max(1_000_000_000).optional(),
    priceMax: z.number().min(0).max(1_000_000_000).optional(),
  }),
  timeout: z.number().int().min(1000).max(60000).optional(),
});

export const quickCheckRoutes = new Hono();

quickCheckRoutes.post("/", zValidator("json", quickCheckSchema), async (c) => {
  const { url, matchConditions, timeout } = c.req.valid("json");

  try {
    const scraped = await scrapeUrl(url, { timeout });

    // Simple text-based item extraction: split by common patterns
    // and apply match conditions without calling the AI
    const text = scraped.text;
    const textLower = text.toLowerCase();

    // Check for anti-bot blocking
    if (scraped.blocked) {
      return c.json({
        url,
        accessible: false,
        blocked: true,
        blockReason: scraped.blockReason,
        matches: [],
        totalTextLength: text.length,
        hasNewMatches: false,
        scrapedAt: scraped.scrapedAt,
      });
    }

    // Check if the page seems accessible (has meaningful content)
    const isAccessible = text.length > 200;

    if (!isAccessible) {
      return c.json({
        url,
        accessible: false,
        matches: [],
        totalTextLength: text.length,
        hasNewMatches: false,
        scrapedAt: scraped.scrapedAt,
      });
    }

    // Apply match conditions against the full page text
    // For quick checks, we treat the entire page as one "item" and check keywords
    const mustInclude = matchConditions.mustInclude ?? [];
    const mustExclude = matchConditions.mustExclude ?? [];

    const includeMatches = mustInclude.filter((kw) =>
      textLower.includes(kw.toLowerCase())
    );
    const excludeMatches = mustExclude.filter((kw) =>
      textLower.includes(kw.toLowerCase())
    );

    const allIncluded = mustInclude.length === 0 || includeMatches.length === mustInclude.length;
    const noneExcluded = excludeMatches.length === 0;
    const keywordsMatch = allIncluded && noneExcluded;

    // Price check: look for price patterns in the text
    const pricePattern = /\$[\d,]+(?:\.\d{2})?/g;
    const prices = [...text.matchAll(pricePattern)].map((m) =>
      parseFloat(m[0].replace(/[$,]/g, ""))
    ).filter((p) => Number.isFinite(p));

    const pricesInRange = prices.filter((p) => {
      if (matchConditions.priceMin != null && p < matchConditions.priceMin) return false;
      if (matchConditions.priceMax != null && p > matchConditions.priceMax) return false;
      return true;
    });

    const hasMatch = keywordsMatch && (prices.length === 0 || pricesInRange.length > 0);

    return c.json({
      url,
      accessible: true,
      hasNewMatches: hasMatch,
      keywordResults: {
        included: includeMatches,
        excluded: excludeMatches,
        allIncluded,
        noneExcluded,
      },
      priceResults: {
        found: prices.length,
        inRange: pricesInRange.length,
        lowestInRange: pricesInRange.length > 0 ? Math.min(...pricesInRange) : null,
      },
      totalTextLength: text.length,
      scrapedAt: scraped.scrapedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[quick-check] Failed for ${url}:`, message);

    const isTimeout = message.includes("Timeout") || message.includes("timed out");
    const isNavigation = message.includes("net::ERR_") || message.includes("Navigation failed");
    const isConcurrency = message.includes("concurrent");
    const isValidationError = message.includes("not allowed") || message.includes("URL")
      || message.toLowerCase().includes("could not resolve") || message.includes("hostname");

    let userMessage: string;
    let statusCode = 500;

    if (isValidationError) {
      userMessage = message;
      statusCode = 400;
    } else if (isTimeout) {
      userMessage = "Page took too long to load. The site may be slow or blocking automated access.";
      statusCode = 504;
    } else if (isNavigation) {
      userMessage = "Could not reach the page. The URL may be invalid or the site may be down.";
    } else if (isConcurrency) {
      userMessage = "Too many concurrent checks. Will retry automatically.";
      statusCode = 429;
    } else {
      userMessage = "Check failed — please try again later.";
    }

    return c.json({ error: "check_failed", message: userMessage }, statusCode as 400 | 429 | 500 | 504);
  }
});
