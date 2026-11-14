import { alertsOnScore, type ExtractedItem, type ExtractionSchema } from "@prowl/shared";
import type { ScoreCandidate, ScoredCandidate } from "./extractor.js";

export type Scorer = (candidates: ScoreCandidate[], readStock: boolean) => Promise<ScoredCandidate[]>;

/** The scorer's limits: entries per call, and characters of text per entry. */
const SCORE_BATCH = 25;
const SNIPPET_MAX = 600;

function toCandidate(item: ExtractedItem): ScoreCandidate {
  const { title, url, price, ...rest } = item;
  return {
    title: String(title ?? ""),
    url: typeof url === "string" ? url : null,
    price: typeof price === "number" ? price : null,
    snippet: Object.entries(rest)
      .map(([field, value]) => `${field}: ${value}`)
      .join("\n")
      .slice(0, SNIPPET_MAX),
  };
}

/**
 * Judge a full read's matches as a quick check judges new entries. The
 * extract's own match conditions are keywords and a price bound: they passed
 * sold-out stock and pages that only mention the product.
 *
 * A match read as sold out, when the prompt asks for stock, is marked so in
 * the items too, which puts it in the restock queue. A scoring failure keeps
 * every match, as a quick check does.
 */
export async function judgeMatches(
  schema: ExtractionSchema,
  matches: ExtractedItem[],
  score: Scorer
): Promise<{ schema: ExtractionSchema; matches: ExtractedItem[] }> {
  if (matches.length === 0) return { schema, matches };
  const readStock = schema.matchConditions?.inStockOnly === true;
  let scored: ScoredCandidate[];
  try {
    const batches: ExtractedItem[][] = [];
    for (let i = 0; i < matches.length; i += SCORE_BATCH) batches.push(matches.slice(i, i + SCORE_BATCH));
    scored = (await Promise.all(batches.map((batch) => score(batch.map(toCandidate), readStock)))).flat();
  } catch (e) {
    console.warn("[judge] Scoring failed, keeping every match:", (e as Error).message);
    return { schema, matches };
  }

  const soldOut = new Set<ExtractedItem>();
  const kept: ExtractedItem[] = [];
  matches.forEach((match, i) => {
    const verdict = scored[i];
    if (readStock && verdict?.stock?.inStock === false) {
      soldOut.add(match);
      return;
    }
    if (!alertsOnScore(verdict?.matchScore)) return;
    kept.push(verdict ? { ...match, matchScore: verdict.matchScore, matchReason: verdict.matchReason } : match);
  });
  return {
    schema: soldOut.size > 0 ? { ...schema, items: schema.items.map((item) => (soldOut.has(item) ? { ...item, inStock: false } : item)) } : schema,
    matches: kept,
  };
}
