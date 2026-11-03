import type { ExtractedItem } from "./types";

export interface PriceChange {
  title: string;
  oldPrice: number;
  newPrice: number;
  change: number;
  changePercent: number;
}

export function getItemKey(item: ExtractedItem): string {
  if (item.url) return String(item.url);
  return `${String(item.title ?? "")}-${String(item.price ?? "")}`;
}
