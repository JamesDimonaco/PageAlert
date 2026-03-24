import Anthropic from "@anthropic-ai/sdk";
import { PostHog } from "posthog-node";
import { withTracing } from "@posthog/ai";
import type { ExtractionSchema, ExtractedItem } from "@prowl/shared";
import { applyMatchConditions } from "@prowl/shared";

// PostHog LLM observability — tracks token usage, cost, latency per generation
const posthogKey = process.env.POSTHOG_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost = process.env.POSTHOG_HOST ?? process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
const posthog = posthogKey ? new PostHog(posthogKey, { host: posthogHost }) : null;

const getClient = () => {
  const client = new Anthropic();
  if (posthog) {
    return withTracing(client, posthog);
  }
  return client;
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
    ]
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

Rules for extraction:
- Extract up to 50 items maximum
- ALWAYS include a "url" field for each item. Links appear as [text](url). If no link exists, use null.
- Keep item data concise: title, price, url, and 1-2 other relevant fields
- Prices should be numbers (no currency symbols)
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
    model: "claude-sonnet-4-20250514",
    max_tokens: 16384,
    messages: [
      {
        role: "user",
        content: `Page URL: ${baseUrl ?? "unknown"}${monitorName ? `\nMonitor name: ${monitorName}` : ""}\n\nPage content:\n\n${truncatedText}\n\nUser is looking for: ${prompt}`,
      },
    ],
    system: EXTRACTION_PROMPT,
  });

  const responseText = message.content[0].type === "text" ? message.content[0].text : "";

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

  // Normalise insights
  const rawInsights = raw.insights as Record<string, unknown> | undefined;
  const insights = rawInsights
    ? {
        understanding: String(rawInsights.understanding ?? ""),
        confidence: typeof rawInsights.confidence === "number" ? rawInsights.confidence : 50,
        matchSignal: String(rawInsights.matchSignal ?? ""),
        noMatchSignal: String(rawInsights.noMatchSignal ?? ""),
        notices: Array.isArray(rawInsights.notices)
          ? rawInsights.notices.filter((n): n is string => typeof n === "string")
          : [],
      }
    : undefined;

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
