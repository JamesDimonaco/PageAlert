/** Countries Find a product can search. `currency` is what its shops price in. */
export const SEARCH_REGIONS = [
  { code: "GB", name: "United Kingdom", currency: "GBP" },
  { code: "US", name: "United States", currency: "USD" },
  { code: "CA", name: "Canada", currency: "CAD" },
  { code: "AU", name: "Australia", currency: "AUD" },
  { code: "NZ", name: "New Zealand", currency: "NZD" },
  { code: "IE", name: "Ireland", currency: "EUR" },
  { code: "DE", name: "Germany", currency: "EUR" },
  { code: "FR", name: "France", currency: "EUR" },
  { code: "ES", name: "Spain", currency: "EUR" },
  { code: "IT", name: "Italy", currency: "EUR" },
  { code: "NL", name: "Netherlands", currency: "EUR" },
] as const;

export type SearchRegion = (typeof SEARCH_REGIONS)[number]["code"];

export function isSearchRegion(code: string): code is SearchRegion {
  return SEARCH_REGIONS.some((r) => r.code === code);
}

/**
 * Best guess at where the user shops: the request's country, then the
 * browser language ("en-GB"), then the US.
 */
export function guessSearchRegion(country: string | null, language: string): SearchRegion {
  const fromCountry = country?.toUpperCase() ?? "";
  if (isSearchRegion(fromCountry)) return fromCountry;
  const fromLanguage = language.split("-")[1]?.toUpperCase() ?? "";
  if (isSearchRegion(fromLanguage)) return fromLanguage;
  return "US";
}

/**
 * Where to search for other shops selling the product on this page. The
 * user's saved region wins unless it prices in another currency than the page.
 * Then the page's currency decides, and the domain ending ("fr", "uk") breaks
 * a tie between countries sharing one.
 */
export function regionForPage(currency: string | undefined, saved: string | null, pageUrl: string): SearchRegion {
  const savedRegion = saved !== null && isSearchRegion(saved) ? SEARCH_REGIONS.find((r) => r.code === saved) : undefined;
  if (savedRegion && (currency === undefined || savedRegion.currency === currency)) return savedRegion.code;
  const candidates = currency === undefined ? SEARCH_REGIONS : SEARCH_REGIONS.filter((r) => r.currency === currency);
  let ending = "";
  try {
    ending = new URL(pageUrl).hostname.split(".").pop()?.toUpperCase() ?? "";
  } catch {
    // Not a URL: no ending to go by.
  }
  const byEnding = candidates.find((r) => r.code === (ending === "UK" ? "GB" : ending));
  if (byEnding) return byEnding.code;
  if (currency !== undefined && candidates[0]) return candidates[0].code;
  return savedRegion?.code ?? "US";
}

export type ListingLabel = "same" | "similar" | "accessory";

/** One product page a search found. */
export interface ProductListing {
  /** Hostname without "www.", e.g. "argos.co.uk". */
  site: string;
  url: string;
  title: string;
  /** Integer minor units (pence, cents). Null when no price could be read. */
  price: number | null;
  /** ISO 4217; set whenever price is. */
  currency: string | null;
  inStock: boolean | null;
  label: ListingLabel;
}
