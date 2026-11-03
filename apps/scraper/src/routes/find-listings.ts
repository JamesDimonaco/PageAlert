import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { SEARCH_REGIONS, type SearchRegion } from "@prowl/shared";
import { findListings } from "../services/find-listings.js";

const regionCodes = SEARCH_REGIONS.map((r) => r.code) as [SearchRegion, ...SearchRegion[]];

const findSchema = z.object({
  query: z.string().trim().min(2).max(200),
  region: z.enum(regionCodes),
  // Analytics attribution only, so a bad value is dropped rather than failing the search.
  userId: z.string().max(200).optional().catch(undefined),
});

export const findListingsRoutes = new Hono();

/** Search the web for shop pages selling a named product. */
findListingsRoutes.post("/", zValidator("json", findSchema), async (c) => {
  const { query, region, userId } = c.req.valid("json");

  try {
    const listings = await findListings(query, region, userId);
    return c.json({ listings });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[find-listings] Failed:", message);
    return c.json({ error: "search_failed", message: "Could not search for that product." }, 500);
  }
});
