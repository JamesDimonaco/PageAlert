import type { ExtractedItem } from "./types";

export interface PriceChange {
  title: string;
  oldPrice: number;
  newPrice: number;
  change: number;
  changePercent: number;
}

export interface ChangeSet {
  added: ExtractedItem[];
  removed: ExtractedItem[];
  priceChanges: PriceChange[];
  summary: string;
}

export function getItemKey(item: ExtractedItem): string {
  if (item.url) return String(item.url);
  return `${String(item.title ?? "")}-${String(item.price ?? "")}`;
}

function getItemTitle(item: ExtractedItem): string {
  return String(item.title ?? item.name ?? "Unknown");
}

/**
 * Compare two sets of extracted items and produce a change set.
 * Detects: new items, removed items, and price changes on items with the same title.
 */
export function detectChanges(
  previousItems: ExtractedItem[],
  currentItems: ExtractedItem[]
): ChangeSet {
  const prevByTitle = new Map<string, ExtractedItem>();
  const currByTitle = new Map<string, ExtractedItem>();

  for (const item of previousItems) {
    prevByTitle.set(getItemTitle(item).toLowerCase(), item);
  }
  for (const item of currentItems) {
    currByTitle.set(getItemTitle(item).toLowerCase(), item);
  }

  // New items: in current but not in previous
  const added = currentItems.filter(
    (item) => !prevByTitle.has(getItemTitle(item).toLowerCase())
  );

  // Removed items: in previous but not in current
  const removed = previousItems.filter(
    (item) => !currByTitle.has(getItemTitle(item).toLowerCase())
  );

  // Price changes: same title, different price
  const priceChanges: PriceChange[] = [];
  for (const [titleKey, currItem] of currByTitle) {
    const prevItem = prevByTitle.get(titleKey);
    if (!prevItem) continue;

    const currPrice = typeof currItem.price === "number" ? currItem.price : NaN;
    const prevPrice = typeof prevItem.price === "number" ? prevItem.price : NaN;

    if (Number.isFinite(currPrice) && Number.isFinite(prevPrice) && currPrice !== prevPrice) {
      const change = currPrice - prevPrice;
      const changePercent = prevPrice !== 0 ? (change / prevPrice) * 100 : 0;
      priceChanges.push({
        title: getItemTitle(currItem),
        oldPrice: prevPrice,
        newPrice: currPrice,
        change,
        changePercent: Math.round(changePercent * 10) / 10,
      });
    }
  }

  // Build summary
  const parts: string[] = [];
  if (added.length > 0) parts.push(`${added.length} new item${added.length !== 1 ? "s" : ""}`);
  if (removed.length > 0) parts.push(`${removed.length} removed`);
  if (priceChanges.length > 0) {
    const drops = priceChanges.filter((p) => p.change < 0).length;
    const increases = priceChanges.filter((p) => p.change > 0).length;
    if (drops > 0) parts.push(`${drops} price drop${drops !== 1 ? "s" : ""}`);
    if (increases > 0) parts.push(`${increases} price increase${increases !== 1 ? "s" : ""}`);
  }

  const summary = parts.length > 0 ? parts.join(", ") : "No changes";

  return { added, removed, priceChanges, summary };
}
