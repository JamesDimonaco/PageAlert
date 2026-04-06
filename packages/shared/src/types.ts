// ---- Scraper API Types ----

export interface ScrapeResponse {
  url: string;
  html: string;
  text: string;
  title: string;
  scrapedAt: string;
}

export interface AiInsights {
  /** Plain English: what the AI thinks the user wants */
  understanding: string;
  /** 0-100 confidence that the AI understood the request and can extract the right data */
  confidence: number;
  /** What a successful match would look like on this page */
  matchSignal: string;
  /** What "no match" / "out of stock" looks like on this page */
  noMatchSignal: string;
  /** Warnings about data limitations (e.g. "RAM not shown on listing page") */
  notices: string[];
  /** Whether the page contains prices associated with items */
  tracksPrices?: boolean;
  /** Up to 5 item titles most relevant for price tracking */
  suggestedPriceTrackItems?: string[];
}

export interface ExtractionSchema {
  fields: Record<string, string>;
  items: ExtractedItem[];
  matchConditions: MatchConditions;
  insights?: AiInsights;
}

export interface ExtractedItem {
  [key: string]: string | number | boolean | null;
}

export interface MatchConditions {
  titleContains?: string[];
  titleExcludes?: string[];
  priceMax?: number;
  priceMin?: number;
  mustInclude?: string[];
  mustExclude?: string[];
}
