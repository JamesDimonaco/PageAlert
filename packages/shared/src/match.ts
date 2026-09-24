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

export function applyMatchConditions(
  items: ExtractedItem[],
  conditions: MatchConditions
): ExtractedItem[] {
  return items.filter((item) => {
    const title = String(item.title || "").toLowerCase();
    const rawPrice =
      typeof item.price === "number"
        ? item.price
        : parseFloat(String(item.price ?? ""));
    const price = Number.isFinite(rawPrice) ? rawPrice : undefined;

    if (conditions.titleContains?.length) {
      const hasAll = conditions.titleContains.every((kw) =>
        title.includes(kw.toLowerCase())
      );
      if (!hasAll) return false;
    }

    if (conditions.titleExcludes?.length) {
      const hasExcluded = conditions.titleExcludes.some((kw) =>
        title.includes(kw.toLowerCase())
      );
      if (hasExcluded) return false;
    }

    // An item with no readable price cannot be known to sit inside the range.
    // Treating "no price" as a pass is how a price filter let everything
    // through on pages where only some entries carry a price.
    const hasPriceFilter =
      conditions.priceMin !== undefined || conditions.priceMax !== undefined;
    if (hasPriceFilter) {
      if (price === undefined) return false;
      if (conditions.priceMax !== undefined && price > conditions.priceMax)
        return false;
      if (conditions.priceMin !== undefined && price < conditions.priceMin)
        return false;
    }

    if (conditions.mustInclude?.length || conditions.mustExclude?.length) {
      const itemStr = itemHaystack(item);

      if (conditions.mustInclude?.length) {
        const hasAll = conditions.mustInclude.every((kw) =>
          itemStr.includes(kw.toLowerCase())
        );
        if (!hasAll) return false;
      }

      if (conditions.mustExclude?.length) {
        const hasExcluded = conditions.mustExclude.some((kw) =>
          itemStr.includes(kw.toLowerCase())
        );
        if (hasExcluded) return false;
      }
    }

    return true;
  });
}
