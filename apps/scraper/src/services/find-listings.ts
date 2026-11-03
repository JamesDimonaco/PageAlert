import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { SEARCH_REGIONS, toMinorUnits, type ProductListing, type SearchRegion } from "@prowl/shared";
import { extractJson, getClient, trackingParams } from "./extractor.js";

export const MAX_LISTINGS = 8;
const MAX_SEARCHES = 5;
// A long search can come back as pause_turn; each resume is another billed call.
const MAX_RESUMES = 2;

const FIND_PROMPT = `You find product pages in online shops.

The user names a product and a country. Use web search to find pages in that country's shops where the product can be bought. Prefer the shop's own product page, not a search results page, category page, review, or comparison site.

Return at most ${MAX_LISTINGS} pages, and at most one page per site.

For each page, label how it relates to what the user named:
- "same": the product they named (any colour or size of it).
- "similar": a different model or version they might also want.
- "accessory": something for the product, like a case, cable or spare part.

Respond with ONLY valid JSON, no markdown fences:
{"listings": [{"site": "argos.co.uk", "url": "https://...", "title": "Product name as the page shows it", "price": 279.99, "currency": "GBP", "inStock": true, "label": "same"}]}

"price" is the number shown, without a symbol, or null if you did not see one. "currency" is the ISO 4217 code. "inStock" is null if you could not tell. If you find nothing, return {"listings": []}.`;

const rawListing = z.object({
  url: z.string(),
  title: z.string().trim().min(1).max(300),
  price: z.number().nullable().catch(null),
  currency: z.string().trim().toUpperCase().length(3).nullable().catch(null),
  inStock: z.boolean().nullable().catch(null),
  label: z.enum(["same", "similar", "accessory"]),
});

const rawResponse = z.object({ listings: z.array(z.unknown()) });

/**
 * Turn the model's JSON into listings we can show.
 *
 * Drops entries that fail validation rather than the whole answer, since one
 * malformed entry should not cost the user the other seven. Keeps only http(s)
 * URLs and the first page per site, and converts prices to minor units.
 */
export function parseListings(text: string): ProductListing[] {
  const json = extractJson(text);
  if (!json) throw new Error("AI returned no extractable JSON");
  const parsed = rawResponse.parse(JSON.parse(json));

  const seen = new Set<string>();
  const listings: ProductListing[] = [];
  for (const entry of parsed.listings) {
    const result = rawListing.safeParse(entry);
    if (!result.success) continue;
    const { url, title, price, currency, inStock, label } = result.data;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") continue;
    const site = parsedUrl.hostname.toLowerCase().replace(/^www\./, "");
    if (seen.has(site)) continue;
    seen.add(site);

    const minor = price !== null && currency !== null ? toMinorUnits(price, currency) : null;
    listings.push({
      site,
      url: parsedUrl.href,
      title,
      price: minor,
      currency: minor === null ? null : currency,
      inStock,
      label,
    });
    if (listings.length === MAX_LISTINGS) break;
  }
  return listings;
}

export async function findListings(query: string, region: SearchRegion, userId?: string): Promise<ProductListing[]> {
  const country = SEARCH_REGIONS.find((r) => r.code === region)?.name ?? region;
  const client = getClient();
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Product: ${query}\nCountry: ${country}` },
  ];

  let message: Anthropic.Message | undefined;
  for (let call = 0; call <= MAX_RESUMES; call++) {
    message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 16000,
      system: FIND_PROMPT,
      tools: [
        {
          type: "web_search_20260209",
          name: "web_search",
          max_uses: MAX_SEARCHES,
          user_location: { type: "approximate", country: region },
        },
      ],
      messages,
      ...trackingParams(userId),
    });
    if (message.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: message.content });
  }
  if (!message || message.stop_reason === "pause_turn") throw new Error("Search did not finish");
  if (message.stop_reason === "max_tokens") throw new Error("AI output hit the token limit");

  // Search answers split the text into cited blocks; joined, they are the JSON.
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  return parseListings(text);
}
