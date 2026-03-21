import Anthropic from "@anthropic-ai/sdk";
import type { ExtractionSchema, ExtractedItem } from "@prowl/shared";
import { applyMatchConditions } from "@prowl/shared";

const getClient = () => new Anthropic();

const EXTRACTION_PROMPT = `You are a web data extraction assistant. Given the text content of a web page and a user's description of what they're looking for, your job is to:

1. Identify the repeating items/products/listings on the page
2. Extract structured data for each item
3. Determine which items match the user's criteria

Respond with ONLY valid JSON in this exact format:
{
  "fields": {
    "title": "description of the title field",
    "price": "description of the price field",
    ...other relevant fields
  },
  "items": [
    { "title": "...", "price": 1299, ...other fields },
    ...all items found on the page
  ],
  "matchConditions": {
    "titleContains": ["keywords", "that", "must", "appear"],
    "titleExcludes": ["keywords", "to", "exclude"],
    "priceMax": 1500,
    "priceMin": 0,
    "mustInclude": ["other", "required", "terms"],
    "mustExclude": ["other", "excluded", "terms"]
  }
}

Rules:
- Extract up to 50 items maximum. If there are more, extract the most relevant ones first
- Keep item data concise - only include title, price, and 1-2 other key fields
- Prices should be numbers (no currency symbols)
- matchConditions should reflect the user's stated criteria
- If you can't determine a field value, use null
- Do NOT wrap your response in markdown code fences - output raw JSON only`;

export async function extractWithAI(
  pageText: string,
  prompt: string
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
        content: `Page content:\n\n${truncatedText}\n\nUser is looking for: ${prompt}`,
      },
    ],
    system: EXTRACTION_PROMPT,
  });

  const responseText = message.content[0].type === "text" ? message.content[0].text : "";

  console.log("[extractor] AI response length:", responseText.length);
  console.log("[extractor] AI response preview:", responseText.slice(0, 300));

  // Try to extract JSON from the response using multiple strategies
  const jsonString = extractJson(responseText);
  if (!jsonString) {
    console.error("[extractor] No JSON found in AI response:", responseText.slice(0, 1000));
    throw new Error("AI returned no extractable JSON");
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(jsonString);
  } catch {
    // The response was likely truncated by max_tokens - try to repair it
    console.warn("[extractor] JSON parse failed, attempting truncation repair...");
    const repaired = repairTruncatedJson(jsonString);
    if (repaired) {
      try {
        raw = JSON.parse(repaired);
        console.log("[extractor] Truncation repair succeeded");
      } catch (e2) {
        console.error("[extractor] Repair also failed:", (e2 as Error).message);
        console.error("[extractor] First 500 chars:", jsonString.slice(0, 500));
        console.error("[extractor] Last 200 chars:", jsonString.slice(-200));
        throw new Error("AI returned invalid JSON");
      }
    } else {
      console.error("[extractor] Could not repair truncated JSON");
      console.error("[extractor] First 500 chars:", jsonString.slice(0, 500));
      console.error("[extractor] Last 200 chars:", jsonString.slice(-200));
      throw new Error("AI returned invalid JSON");
    }
  }

  // Normalise into our expected schema shape - be lenient about what AI returns
  const parsed: ExtractionSchema = {
    fields: (raw.fields as Record<string, string>) ?? {},
    items: Array.isArray(raw.items) ? raw.items : [],
    matchConditions: {
      titleContains: getStringArray(raw.matchConditions, "titleContains"),
      titleExcludes: getStringArray(raw.matchConditions, "titleExcludes"),
      priceMax: getNumber(raw.matchConditions, "priceMax"),
      priceMin: getNumber(raw.matchConditions, "priceMin"),
      mustInclude: getStringArray(raw.matchConditions, "mustInclude"),
      mustExclude: getStringArray(raw.matchConditions, "mustExclude"),
    },
  };

  console.log("[extractor] Parsed %d items, %d fields", parsed.items.length, Object.keys(parsed.fields).length);

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

// applyMatchConditions is re-exported from @prowl/shared
export { applyMatchConditions } from "@prowl/shared";
