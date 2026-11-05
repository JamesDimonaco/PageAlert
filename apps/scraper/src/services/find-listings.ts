import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { SEARCH_REGIONS, toMinorUnits, type ProductListing, type SearchRegion } from "@prowl/shared";
import { getClient, trackingParams } from "./extractor.js";

export const MAX_LISTINGS = 8;
const MAX_SEARCHES = 5;
// A long search can come back as pause_turn; each resume is another billed call.
const MAX_RESUMES = 2;
// Every call, resumes and SDK retries included, ends by then. Kept well under
// the 150s Convex waits, so the caller always gets an answer it can refund on.
const SEARCH_BUDGET_MS = 110_000;

export type SearchFailureReason = "no_json" | "bad_shape" | "did_not_finish" | "token_limit" | "timeout" | "ai_error" | "unknown";

/** A search that ran but whose answer we could not use, with why. */
export class SearchFailure extends Error {
  constructor(readonly reason: SearchFailureReason, message: string) {
    super(message);
    this.name = "SearchFailure";
  }
}

/** Class names up the prototype chain, e.g. ["APIUserAbortError", "APIError", "Error"]. */
function classNames(error: object): string[] {
  const names: string[] = [];
  for (let proto = Object.getPrototypeOf(error); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    names.push(proto.constructor.name);
  }
  return names;
}

export function searchFailureReason(error: unknown): SearchFailureReason {
  if (error instanceof SearchFailure) return error.reason;
  if (typeof error !== "object" || error === null) return "unknown";
  // Matched by class name, not instanceof: the PostHog wrapper throws from its
  // own bundled SDK copy. The SDK turns our search-budget abort into APIUserAbortError.
  const names = classNames(error);
  if (names.includes("APIUserAbortError") || names.includes("APIConnectionTimeoutError")) return "timeout";
  if (names.includes("APIError")) return "ai_error";
  return "unknown";
}

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

/** Index of the brace that closes the one at `start`, skipping braces inside strings. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * The answer's JSON object. Narration before or after it can hold braces of
 * its own ("{GMT}"), so this takes the first balanced object that parses and
 * has a listings key.
 */
function answerObject(text: string): unknown {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = matchingBrace(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (typeof value === "object" && value !== null && "listings" in value) return value;
    } catch {
      // Narration, not the answer; try the next brace.
    }
  }
  throw new SearchFailure("no_json", "AI returned no extractable JSON");
}

/**
 * Turn the model's JSON into listings we can show.
 *
 * Drops entries that fail validation rather than the whole answer, since one
 * malformed entry should not cost the user the other seven. Keeps only http(s)
 * URLs and the first page per site, and converts prices to minor units.
 */
export function parseListings(text: string): ProductListing[] {
  const response = rawResponse.safeParse(answerObject(text));
  if (!response.success) throw new SearchFailure("bad_shape", "AI answer has no listings array");
  const parsed = response.data;

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

  const signal = AbortSignal.timeout(SEARCH_BUDGET_MS);
  let message: Anthropic.Message | undefined;
  for (let call = 0; call <= MAX_RESUMES; call++) {
    message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 16000,
      // Sonnet 5 thinks by default and those tokens come out of max_tokens,
      // shared here with the search results the model reads. Finding pages and
      // labelling them does not need the reasoning; the answer needs the room.
      thinking: { type: "disabled" },
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
    }, { signal });
    if (message.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: message.content });
  }
  if (!message || message.stop_reason === "pause_turn") throw new SearchFailure("did_not_finish", "Search did not finish");
  if (message.stop_reason === "max_tokens") throw new SearchFailure("token_limit", "AI output hit the token limit");

  // The answer is the text after the last search result. It can arrive as
  // several cited blocks, which joined make the JSON; text before that is
  // narration between searches.
  const types = message.content.map((block) => block.type);
  const text = message.content
    .slice(types.lastIndexOf("web_search_tool_result") + 1)
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  // The only record of what the model said: PostHog's LLM capture runs in privacy mode.
  const logAnswer = (label: string) =>
    console.error(`[find-listings] ${label}:`, JSON.stringify({ types, text: text.slice(0, 1500) }));
  let listings: ProductListing[];
  try {
    listings = parseListings(text);
  } catch (error) {
    logAnswer("Unreadable answer");
    throw error;
  }
  if (listings.length === 0) logAnswer("No usable listings");
  return listings;
}
