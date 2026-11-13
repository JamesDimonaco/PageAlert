import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { scoreCandidates } from "../services/extractor.js";
import { MAX_URL_LENGTH } from "../utils/url-validation.js";
import { PRODUCT_EXCERPT_MAX } from "@prowl/shared";

const MAX_CANDIDATES = 25;
const MAX_SNIPPET_LENGTH = 600;

const scoreSchema = z.object({
  prompt: z.string().min(1).max(2000),
  name: z.string().max(200).optional(),
  // Analytics attribution only, so a bad value is dropped rather than failing the scan.
  userId: z.string().max(200).optional().catch(undefined),
  candidates: z
    .array(
      z.object({
        title: z.string().max(500),
        url: z.string().max(MAX_URL_LENGTH).nullable(),
        price: z.number().nullable(),
        snippet: z.string().max(PRODUCT_EXCERPT_MAX),
      })
    )
    .min(1)
    .max(MAX_CANDIDATES),
  // Also read stock and price: for one product, or for listing entries when
  // the prompt asks for stock.
  readStock: z.boolean().optional(),
}).refine(
  // Only a lone product read may send the longer product excerpt.
  (body) =>
    (body.readStock && body.candidates.length === 1) ||
    body.candidates.every((c) => c.snippet.length <= MAX_SNIPPET_LENGTH),
  { message: "Snippets are capped, except one product's excerpt with readStock" }
);

export const scoreRoutes = new Hono();

/**
 * Judge entries the deterministic filter already picked.
 *
 * Separate from /extract because it never scrapes: the caller passes the
 * entries it wants judged, so this costs a fraction of reading a whole page
 * and runs only when there is something new to judge.
 */
scoreRoutes.post("/", zValidator("json", scoreSchema), async (c) => {
  const { prompt, name, userId, candidates, readStock } = c.req.valid("json");

  try {
    const scored = await scoreCandidates(candidates, prompt, name, userId, readStock);
    return c.json({ scored });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[score] Failed:", message);
    return c.json({ error: "score_failed", message: "Could not score matches." }, 500);
  }
});
