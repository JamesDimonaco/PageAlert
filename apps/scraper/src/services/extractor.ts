import AnthropicOriginal from "@anthropic-ai/sdk";
import { PostHog } from "posthog-node";
import { Anthropic as PostHogAnthropic } from "@posthog/ai";
import type { ExtractionSchema, ExtractedItem } from "@prowl/shared";
import { applyMatchConditions } from "@prowl/shared";

// PostHog LLM observability — tracks token usage, cost, latency per generation
const posthogKey = process.env.POSTHOG_KEY;
const posthogHost = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";
const posthog = posthogKey ? new PostHog(posthogKey, { host: posthogHost }) : null;

if (posthog) {
  process.on("SIGTERM", async () => { await posthog.shutdown(); process.exit(0); });
  process.on("SIGINT", async () => { await posthog.shutdown(); process.exit(0); });
}

const getClient = (): AnthropicOriginal => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (posthog && apiKey) {
    // Wrapped client — auto-captures $ai_generation events
    return new PostHogAnthropic({
      apiKey,
      posthog,
    }) as unknown as AnthropicOriginal;
  }
  return new AnthropicOriginal();
};

const EXTRACTION_PROMPT = `You are a web data extraction assistant. Given:
- The text content of a web page (with links as [text](url))
- A monitor name (context about what the user named this search)
- A user prompt describing what they're looking for

Your job is to extract structured data AND help the user understand what you found.

Respond with ONLY valid JSON in this exact format:
{
  "insights": {
    "understanding": "Plain English summary of what you think the user wants. Be specific.",
    "confidence": 85,
    "matchSignal": "What a successful match looks like on THIS page (e.g. 'Item appears in listing with size 8 shown as available')",
    "noMatchSignal": "What no-match / out-of-stock looks like on THIS page (e.g. 'Size 8 not listed in available sizes')",
    "notices": [
      "Any limitations, e.g. 'RAM specs not shown on listing page - only visible on individual product pages'",
      "Another notice if needed"
    ],
    "tracksPrices": true,
    "suggestedPriceTrackItems": ["Item title 1", "Item title 2"]
  },
  "fields": {
    "title": "description",
    "price": "description",
    "url": "description"
  },
  "items": [
    { "title": "...", "price": 1299, "url": "https://...", ...other fields },
    ...
  ],
  "matchConditions": {
    "mustInclude": ["keyword1", "keyword2"],
    "mustExclude": ["unwanted1"],
    "priceMin": 0,
    "priceMax": 1500
  }
}

Rules for insights:
- "understanding": Restate what the user wants in your own words. Be specific about product, specs, conditions.
- "confidence": 0-100. Lower if the page doesn't contain the data needed to match (e.g. specs only on product pages, not listings). Lower if the page structure is unusual.
- "matchSignal": Describe concretely what would need to appear/change on this page for the user's criteria to be met.
- "noMatchSignal": Describe what the current "no match" state looks like.
- "notices": IMPORTANT - list anything the user should know. Examples:
  - Data that's missing from this page but would be on sub-pages (RAM, sizes, colors)
  - If the page is a listing and detailed specs require clicking through
  - If stock/availability isn't shown on this page
  - If prices might change or are regional
  - Keep each notice concise and actionable
- "tracksPrices": true if the page contains prices associated with items (product listings, auction results, classified ads, etc). false if the page is a job board, news feed, forum, or other non-price content. This determines whether price tracking features are shown to the user.
- "suggestedPriceTrackItems": If tracksPrices is true, list up to 5 item titles that are most relevant to the user's search prompt and most likely to have meaningful price changes. Pick items that match or nearly match the user's criteria. Omit if tracksPrices is false.

Rules for extraction:
- IMPORTANT: Extract ALL product/listing items on the page, not just ones that match the user's criteria. Include up to 50 items.
- The user needs to see all items so they can adjust their filters. Extract every product, listing, or result card visible.
- Do NOT extract page chrome like navigation links, breadcrumbs, filter buttons, ads, or pagination controls — only actual product/listing entries.
- ALWAYS include a "url" field for each item. Links appear as [text](url). If no link exists, use null.
- Keep item data concise: title, price, url, currency, and 1-2 other relevant fields
- Prices MUST be the actual price shown for that specific item. Be very careful with sites like Amazon where prices are split across HTML elements.
- Price should be a number (no currency symbols). Include a separate "currency" field (e.g. "USD", "GBP", "EUR") if the page shows a non-USD currency.
- matchConditions should reflect ONLY the user's stated criteria — these are used to highlight which items match
- matchConditions.mustInclude: keywords that must appear ANYWHERE in the item
- matchConditions.mustExclude: keywords that must NOT appear anywhere
- priceMin/priceMax: price range filter
- If you can't determine a field value, use null
- Do NOT wrap your response in markdown code fences - output raw JSON only`;

export async function extractWithAI(
  pageText: string,
  prompt: string,
  baseUrl?: string,
  monitorName?: string
): Promise<{ schema: ExtractionSchema; matches: ExtractedItem[] }> {
  const client = getClient();

  // Truncate page text if too long (keep under ~100k chars for token limits)
  const truncatedText = pageText.length > 100000 ? pageText.slice(0, 100000) + "\n...[truncated]" : pageText;

  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 16384,
    // Sonnet 5 thinks by default and those tokens come out of max_tokens, so
    // a big listing page got its JSON cut off. This is a one-shot JSON task;
    // it does not need the reasoning.
    thinking: { type: "disabled" },
    messages: [
      {
        role: "user",
        content: `Page URL: ${baseUrl ?? "unknown"}${monitorName ? `\nMonitor name: ${monitorName}` : ""}\n\nPage content:\n\n${truncatedText}\n\nUser is looking for: ${prompt}`,
      },
    ],
    system: EXTRACTION_PROMPT,
  });

  if (message.stop_reason === "max_tokens") {
    throw new Error("AI output hit the token limit - page has too many items");
  }

  // Never index content[0]: block order is not guaranteed.
  const responseText = message.content
    .filter((block): block is AnthropicOriginal.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  console.log("[extractor] AI response length:", responseText.length);
  if (process.env.DEBUG === "true") {
    console.log("[extractor] AI response preview:", responseText.slice(0, 300));
  }

  // Try to extract JSON from the response using multiple strategies
  const jsonString = extractJson(responseText);
  if (!jsonString) {
    if (process.env.DEBUG === "true") {
      console.error("[extractor] No JSON found in AI response:", responseText.slice(0, 1000));
    }
    throw new Error("AI returned no extractable JSON");
  }

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(jsonString);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("AI returned invalid JSON: expected a plain object");
    }
    raw = parsed as Record<string, unknown>;
  } catch (e) {
    if ((e as Error).message.includes("AI returned invalid JSON")) throw e;
    // The response was likely truncated by max_tokens - try to repair it
    console.warn("[extractor] JSON parse failed, attempting truncation repair...");
    const repaired = repairTruncatedJson(jsonString);
    if (repaired) {
      try {
        const parsed: unknown = JSON.parse(repaired);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("AI returned invalid JSON: expected a plain object");
        }
        raw = parsed as Record<string, unknown>;
        console.log("[extractor] Truncation repair succeeded");
      } catch (e2) {
        console.error("[extractor] Repair also failed:", (e2 as Error).message);
        if (process.env.DEBUG === "true") {
          console.error("[extractor] First 500 chars:", jsonString.slice(0, 500));
          console.error("[extractor] Last 200 chars:", jsonString.slice(-200));
        }
        throw new Error("AI returned invalid JSON");
      }
    } else {
      console.error("[extractor] Could not repair truncated JSON");
      if (process.env.DEBUG === "true") {
        console.error("[extractor] First 500 chars:", jsonString.slice(0, 500));
        console.error("[extractor] Last 200 chars:", jsonString.slice(-200));
      }
      throw new Error("AI returned invalid JSON");
    }
  }

  // Normalise insights — always produce an object so tracksPrices is inferred even when AI omits insights
  const rawInsights = (raw.insights as Record<string, unknown>) ?? {};
  const inferredTracksPrices = Array.isArray(raw.items) && raw.items.some((item: Record<string, unknown>) => typeof item.price === "number");
  const insights = {
    understanding: String(rawInsights.understanding ?? ""),
    confidence: typeof rawInsights.confidence === "number" ? rawInsights.confidence : 50,
    matchSignal: String(rawInsights.matchSignal ?? ""),
    noMatchSignal: String(rawInsights.noMatchSignal ?? ""),
    notices: Array.isArray(rawInsights.notices)
      ? rawInsights.notices.filter((n): n is string => typeof n === "string")
      : [],
    tracksPrices: typeof rawInsights.tracksPrices === "boolean"
      ? rawInsights.tracksPrices
      : inferredTracksPrices,
    suggestedPriceTrackItems: Array.isArray(rawInsights.suggestedPriceTrackItems)
      ? rawInsights.suggestedPriceTrackItems.filter((n): n is string => typeof n === "string").slice(0, 5)
      : [],
  };

  // Normalise into our expected schema shape - be lenient about what AI returns
  const parsed: ExtractionSchema = {
    fields: (raw.fields as Record<string, string>) ?? {},
    items: Array.isArray(raw.items) ? raw.items.filter((i): i is ExtractedItem => i != null && typeof i === "object").slice(0, 50) : [],
    matchConditions: {
      priceMax: getNumber(raw.matchConditions, "priceMax"),
      priceMin: getNumber(raw.matchConditions, "priceMin"),
      mustInclude: getStringArray(raw.matchConditions, "mustInclude"),
      mustExclude: getStringArray(raw.matchConditions, "mustExclude"),
    },
    insights,
  };

  console.log("[extractor] Parsed %d items, %d fields, confidence: %d%",
    parsed.items.length, Object.keys(parsed.fields).length, insights?.confidence ?? 0);
  if (insights?.notices?.length) {
    console.log("[extractor] Notices:", insights.notices);
  }

  const matches = applyMatchConditions(parsed.items, parsed.matchConditions);
  console.log("[extractor] Found %d matches out of %d items", matches.length, parsed.items.length);

  return { schema: parsed, matches };
}

/**
 * Attempt to repair JSON that was truncated mid-output (e.g. by max_tokens).
 * Finds the last valid item boundary and closes all open brackets.
 */
function repairTruncatedJson(json: string): string | null {
  // Find the last complete object in an array (ends with })
  // Then close any open arrays and objects
  const lastCompleteObject = json.lastIndexOf("},");
  const lastCompleteObjectAlt = json.lastIndexOf("}");

  // Use whichever gives us a valid-looking cutoff
  let cutPoint = lastCompleteObject > 0 ? lastCompleteObject + 1 : lastCompleteObjectAlt;
  if (cutPoint <= 0) return null;

  let attempt = json.slice(0, cutPoint);

  // Count unclosed brackets
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;

  for (const ch of attempt) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") openBraces++;
    if (ch === "}") openBraces--;
    if (ch === "[") openBrackets++;
    if (ch === "]") openBrackets--;
  }

  // Close any open brackets/braces
  for (let i = 0; i < openBrackets; i++) attempt += "]";
  for (let i = 0; i < openBraces; i++) attempt += "}";

  return attempt;
}

/** Try multiple strategies to extract a JSON string from AI response text */
function extractJson(text: string): string | null {
  const trimmed = text.trim();

  // Strategy 1: Already valid JSON
  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  // Strategy 2: Extract from markdown code fences (greedy to get the full block)
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*)\n\s*```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  // Strategy 3: Find outermost { } braces
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

function getStringArray(obj: unknown, key: string): string[] | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const val = (obj as Record<string, unknown>)[key];
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string");
  return undefined;
}

function getNumber(obj: unknown, key: string): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const val = (obj as Record<string, unknown>)[key];
  if (typeof val === "number") return val;
  return undefined;
}

/** One entry the deterministic pre-filter thinks might match. */
export interface ScoreCandidate {
  title: string;
  url: string | null;
  price: number | null;
  /** The entry's own text from the page, not the whole page. */
  snippet: string;
}

export interface ScoredCandidate extends ScoreCandidate {
  /**
   * 0-100: how well this entry meets what the user actually asked for.
   * Null means the judgement did not come back — never "scored zero".
   */
  matchScore: number | null;
  /** One line the user can read to see why. */
  matchReason: string;
}

const SCORING_PROMPT = `You judge whether listing entries match what a user asked to be alerted about.

You get the user's request and a numbered list of entries taken from one page. Each entry is the text of a single listing — not the whole page.

Score each entry 0-100 for how well it meets the user's request:
- 90-100: meets every stated criterion, confirmed by the entry's own text.
- 70-89: meets the criteria that are visible, but the entry does not show them all.
- 40-69: plausibly related, but a stated criterion is contradicted or missing.
- 0-39: wrong item, wrong variant, or the entry is navigation/promotional rather than a listing.

Judge only against what the user asked for. A keyword appearing in the text is not a match if the entry is the wrong product, the wrong variant, out of stock when the user wants stock, or outside a stated price range. Say so in the reason.

Respond with ONLY valid JSON, no markdown fences:
{"scores": [{"index": 1, "matchScore": 95, "matchReason": "One short sentence, addressed to the user."}]}

Return one entry per input index, in any order. Keep each reason under 20 words.`;

/**
 * Score pre-filtered entries against the user's request.
 *
 * Runs on the entries the keyword filter already picked, not the page, so it
 * costs a fraction of a full extract and sees no surrounding noise. An entry
 * the model does not come back on scores null rather than zero — callers must
 * be able to tell "judged poorly" from "not judged", or a scoring wobble
 * silences a real restock.
 */
export async function scoreCandidates(
  candidates: ScoreCandidate[],
  prompt: string,
  monitorName?: string
): Promise<ScoredCandidate[]> {
  if (candidates.length === 0) return [];

  const listed = candidates
    .map((candidate, i) => {
      const price = candidate.price != null ? `\nPrice: ${candidate.price}` : "";
      return `[${i + 1}] ${candidate.title}${price}\n${candidate.snippet}`;
    })
    .join("\n\n---\n\n");

  const client = getClient();
  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    // A short judging task; the reasoning tokens would come out of max_tokens.
    thinking: { type: "disabled" },
    system: SCORING_PROMPT,
    messages: [
      {
        role: "user",
        content: `${monitorName ? `Monitor name: ${monitorName}\n` : ""}User is looking for: ${prompt}\n\nEntries:\n\n${listed}`,
      },
    ],
  });

  const responseText = message.content
    .filter((block): block is AnthropicOriginal.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const scores = new Map<number, { matchScore: number; matchReason: string }>();
  const jsonString = extractJson(responseText);
  if (jsonString) {
    try {
      const parsed = JSON.parse(jsonString) as { scores?: unknown };
      if (Array.isArray(parsed.scores)) {
        for (const entry of parsed.scores as Record<string, unknown>[]) {
          const index = typeof entry.index === "number" ? entry.index : NaN;
          const score = typeof entry.matchScore === "number" ? entry.matchScore : NaN;
          if (!Number.isFinite(index) || !Number.isFinite(score)) continue;
          scores.set(index, {
            matchScore: Math.max(0, Math.min(100, Math.round(score))),
            matchReason: typeof entry.matchReason === "string" ? entry.matchReason : "",
          });
        }
      }
    } catch (e) {
      console.warn("[extractor] Candidate scoring returned unparseable JSON:", (e as Error).message);
    }
  } else {
    console.warn("[extractor] Candidate scoring returned no JSON");
  }

  return candidates.map((candidate, i) => {
    const scored = scores.get(i + 1);
    return {
      ...candidate,
      matchScore: scored?.matchScore ?? null,
      matchReason: scored?.matchReason ?? "",
    };
  });
}
