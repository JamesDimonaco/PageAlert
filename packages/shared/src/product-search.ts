/** Countries Find a product can search. `sites` fills "Searching UK sites". */
export const SEARCH_REGIONS = [
  { code: "GB", name: "United Kingdom", sites: "UK" },
  { code: "US", name: "United States", sites: "US" },
  { code: "CA", name: "Canada", sites: "Canadian" },
  { code: "AU", name: "Australia", sites: "Australian" },
  { code: "IE", name: "Ireland", sites: "Irish" },
  { code: "DE", name: "Germany", sites: "German" },
  { code: "FR", name: "France", sites: "French" },
  { code: "ES", name: "Spain", sites: "Spanish" },
  { code: "IT", name: "Italy", sites: "Italian" },
  { code: "NL", name: "Netherlands", sites: "Dutch" },
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
