import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { matchPageSegments, segmentPage } from "@prowl/shared";
import { FALLBACK_PROVIDER_ERROR, scrapeUrl } from "../services/scraper.js";
import { MAX_URL_LENGTH } from "../utils/url-validation.js";
import { hashContent } from "../utils/content-hash.js";

const MAX_KEYWORD_LENGTH = 200;
/**
 * Entries returned per check.
 *
 * Held well above the number anyone would be judged or alerted on, because
 * the caller diffs this list to decide what is new. Truncating it tighter
 * makes entries drop out of the seen set as page order shifts and then
 * re-announce themselves as new arrivals.
 */
const MAX_CANDIDATES = 100;
/** Per-entry text handed on for AI scoring — a listing card, not a page. */
const MAX_SNIPPET_LENGTH = 600;
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
  retryAttempt: z.number().int().min(0).max(10).optional(),
  useProxy: z.boolean().optional(),
});

export const quickCheckRoutes = new Hono();

quickCheckRoutes.post("/", zValidator("json", quickCheckSchema), async (c) => {
  const { url, matchConditions, timeout, retryAttempt, useProxy } = c.req.valid("json");

  try {
    const scraped = await scrapeUrl(url, { timeout, retryAttempt, useProxy });

    const text = scraped.text;

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

    // Match per listing entry rather than against the whole page. The scan
    // this replaced asked only whether the keywords and a price in range
    // appeared somewhere, so two unrelated products could satisfy one
    // condition set between them.
    const entries = segmentPage(text);
    const candidates = matchPageSegments(text, matchConditions)
      .slice(0, MAX_CANDIDATES)
      .map((segment) => ({
        title: segment.title || segment.url || "Item",
        url: segment.url,
        price: segment.pricesInRange.length > 0 ? Math.min(...segment.pricesInRange) : null,
        // Enough of the entry for the AI to judge it without re-reading the page.
        snippet: segment.text.trim().slice(0, MAX_SNIPPET_LENGTH),
      }));

    return c.json({
      url,
      accessible: true,
      contentHash: hashContent(text),
      candidates,
      // Listing entries on the page, not just the matching ones — this is the
      // "out of N items" a user reads in an alert.
      totalEntries: entries.length,
      hasNewMatches: candidates.length > 0,
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

    if (message.startsWith("Site is blocking automated access") || message.startsWith(FALLBACK_PROVIDER_ERROR)) {
      // Fallback outcomes carry their own reason. Checked first: the reason text
      // can contain words the branches below match on.
      userMessage = message;
      statusCode = message.startsWith(FALLBACK_PROVIDER_ERROR) ? 502 : 500;
    } else if (isValidationError) {
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

    return c.json({ error: "check_failed", message: userMessage }, statusCode as 400 | 429 | 500 | 502 | 504);
  }
});
