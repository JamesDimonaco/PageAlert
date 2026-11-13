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
