import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { scoreCandidates } from "../services/extractor.js";
import { MAX_URL_LENGTH } from "../utils/url-validation.js";

const MAX_CANDIDATES = 25;
const MAX_SNIPPET_LENGTH = 600;

const scoreSchema = z.object({
  prompt: z.string().min(1).max(2000),
  name: z.string().max(200).optional(),
  candidates: z
    .array(
      z.object({
        title: z.string().max(500),
        url: z.string().max(MAX_URL_LENGTH).nullable(),
        price: z.number().nullable(),
        snippet: z.string().max(MAX_SNIPPET_LENGTH),
      })
    )
    .min(1)
    .max(MAX_CANDIDATES),
});

export const scoreRoutes = new Hono();

/**
 * Judge entries the deterministic filter already picked.
 *
 * Separate from /extract because it never scrapes: the caller passes the
 * entries it wants judged, so this costs a fraction of reading a whole page
 * and runs only when there is something new to alert on.
 */
scoreRoutes.post("/", zValidator("json", scoreSchema), async (c) => {
  const { prompt, name, candidates } = c.req.valid("json");

  try {
    const scored = await scoreCandidates(candidates, prompt, name);
    return c.json({ scored });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[score] Failed:", message);
    return c.json({ error: "score_failed", message: "Could not score matches." }, 500);
  }
});
