import type { ExtractedItem, MatchConditions } from "./types";

/**
 * The text of an item's values, for keyword matching.
 *
 * Deliberately not `JSON.stringify(item)`, which also carries the field names:
 * against that, `mustInclude: ["price"]` matched every item that had a price
 * field and `mustExclude: ["url"]` excluded the entire page.
 */
function itemHaystack(item: ExtractedItem): string {
  return Object.values(item)
    .filter((v) => v !== null && v !== undefined)
    .join(" ")
    .toLowerCase();
}

/** One condition checked against one item, so the UI can say why it missed. */
export type MatchCheck =
  | { kind: "titleContains" | "titleExcludes" | "mustInclude" | "mustExclude"; word: string; pass: boolean }
  | { kind: "price"; min: number | undefined; max: number | undefined; price: number | undefined; pass: boolean }
  /** inStock null means the page does not show stock. It passes, and the UI says so. */
  | { kind: "stock"; inStock: boolean | null; pass: boolean };

function readPrice(item: ExtractedItem): number | undefined {
  const raw = typeof item.price === "number" ? item.price : parseFloat(String(item.price ?? ""));
  return Number.isFinite(raw) ? raw : undefined;
}

/** Every condition, in order, with whether this item passes it. */
export function explainMatch(item: ExtractedItem, conditions: MatchConditions): MatchCheck[] {
  const checks: MatchCheck[] = [];
  const title = String(item.title || "").toLowerCase();

  for (const word of conditions.titleContains ?? []) {
    checks.push({ kind: "titleContains", word, pass: title.includes(word.toLowerCase()) });
  }
  for (const word of conditions.titleExcludes ?? []) {
    checks.push({ kind: "titleExcludes", word, pass: !title.includes(word.toLowerCase()) });
  }

  // An item with no readable price cannot be known to sit inside the range.
  // Treating "no price" as a pass is how a price filter let everything
  // through on pages where only some entries carry a price.
  const { priceMin: min, priceMax: max } = conditions;
  if (min !== undefined || max !== undefined) {
    const price = readPrice(item);
    const pass =
      price !== undefined && (max === undefined || price <= max) && (min === undefined || price >= min);
    checks.push({ kind: "price", min, max, price, pass });
  }

  if (conditions.inStockOnly) {
    const inStock = typeof item.inStock === "boolean" ? item.inStock : null;
    checks.push({ kind: "stock", inStock, pass: inStock !== false });
  }

  if (conditions.mustInclude?.length || conditions.mustExclude?.length) {
    const haystack = itemHaystack(item);
    for (const word of conditions.mustInclude ?? []) {
      checks.push({ kind: "mustInclude", word, pass: haystack.includes(word.toLowerCase()) });
    }
    for (const word of conditions.mustExclude ?? []) {
      checks.push({ kind: "mustExclude", word, pass: !haystack.includes(word.toLowerCase()) });
    }
  }

  return checks;
}

export function applyMatchConditions(
  items: ExtractedItem[],
  conditions: MatchConditions
): ExtractedItem[] {
  return items.filter((item) => explainMatch(item, conditions).every((check) => check.pass));
}

/**
 * One line for a match alert when stock was asked for but some matches did
 * not show it. They matched because the page did not say, and the alert must
 * not let them read as in stock. Null when there is nothing to say.
 *
 * Counts only an explicit null from the full read. Quick-check matches have
 * no inStock field, because the scorer judged stock from their text.
 */
export function stockNotShownNote(matches: ExtractedItem[], conditions: MatchConditions | undefined): string | null {
  if (!conditions?.inStockOnly) return null;
  const unknown = matches.filter((item) => item.inStock === null);
  if (unknown.length === 0) return null;
  if (unknown.length === 1) return `Stock not shown on page for “${String(unknown[0].title ?? "this item")}”.`;
  return `Stock not shown on page for ${unknown.length} of these matches.`;
}
