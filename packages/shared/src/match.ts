import type { ExtractedItem, MatchConditions } from "./types";

export function applyMatchConditions(
  items: ExtractedItem[],
  conditions: MatchConditions
): ExtractedItem[] {
  return items.filter((item) => {
    const title = String(item.title || "").toLowerCase();
    const price =
      typeof item.price === "number"
        ? item.price
        : parseFloat(String(item.price || "0"));

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

    if (conditions.priceMax !== undefined && price > conditions.priceMax)
      return false;
    if (conditions.priceMin !== undefined && price < conditions.priceMin)
      return false;

    if (conditions.mustInclude?.length) {
      const itemStr = JSON.stringify(item).toLowerCase();
      const hasAll = conditions.mustInclude.every((kw) =>
        itemStr.includes(kw.toLowerCase())
      );
      if (!hasAll) return false;
    }

    if (conditions.mustExclude?.length) {
      const itemStr = JSON.stringify(item).toLowerCase();
      const hasExcluded = conditions.mustExclude.some((kw) =>
        itemStr.includes(kw.toLowerCase())
      );
      if (hasExcluded) return false;
    }

    return true;
  });
}
