/**
 * Run product search with both web search tool versions, to check whether the
 * dynamic-filtering one (web_search_20260209) has started working.
 *
 *   cd apps/scraper && npx tsx --env-file=.env scripts/compare-web-search.ts "Nintendo Switch 2" "Dyson V15 Detect"
 *
 * Every search is a real, billed API call (about $0.05-0.30 each).
 */
import { findListings, searchFailureReason, type WebSearchTool } from "../src/services/find-listings.js";

const queries = process.argv.slice(2);
if (queries.length === 0) {
  console.error('Usage: npx tsx --env-file=.env scripts/compare-web-search.ts "<product>" ["<product>" ...]');
  process.exit(1);
}

const tools: WebSearchTool[] = ["web_search_20250305", "web_search_20260209"];
const runs = queries.flatMap((query) => tools.map((tool) => ({ query, tool })));

const results = await Promise.all(
  runs.map(async ({ query, tool }) => {
    const start = Date.now();
    try {
      const listings = await findListings(query, "GB", undefined, tool);
      return { query, tool, secs: (Date.now() - start) / 1000, result: `${listings.length} listings: ${listings.map((l) => l.site).join(", ")}` };
    } catch (error) {
      return { query, tool, secs: (Date.now() - start) / 1000, result: `failed (${searchFailureReason(error)})` };
    }
  }),
);

for (const { query, tool, secs, result } of results) {
  console.log(`${query} | ${tool} | ${secs.toFixed(1)}s | ${result}`);
}
