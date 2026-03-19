import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { scrapeUrl } from "../services/scraper.js";
import { MAX_URL_LENGTH } from "../utils/url-validation.js";

const scrapeSchema = z.object({
  url: z.string().url().max(MAX_URL_LENGTH),
  timeout: z.number().int().min(1000).max(60000).optional(),
  waitFor: z.string().max(200).optional(),
});

export const scrapeRoutes = new Hono();

scrapeRoutes.post("/", zValidator("json", scrapeSchema), async (c) => {
  const { url, timeout, waitFor } = c.req.valid("json");

  try {
    const result = await scrapeUrl(url, { timeout, waitFor });
    return c.json(result);
  } catch (error) {
    // Only expose safe error messages; do not leak internal details
    const safeMessages = [
      "URL exceeds maximum length",
      "Invalid URL format",
      "Only http and https URLs are allowed",
      "URL must contain a valid hostname",
      "This hostname is not allowed",
      "URLs pointing to private/internal IP addresses are not allowed",
      "URL resolves to a private/internal IP address",
      "Could not resolve hostname",
      "Too many concurrent scraping requests",
      "Page content exceeds maximum allowed size",
    ];
    const message = error instanceof Error ? error.message : "";
    const isSafe = safeMessages.some((m) => message.startsWith(m));
    return c.json(
      { error: "scrape_failed", message: isSafe ? message : "Scrape failed", statusCode: 500 },
      500
    );
  }
});
