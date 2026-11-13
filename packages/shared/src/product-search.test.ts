import { describe, expect, it } from "vitest";
import { SEARCH_REGIONS, guessSearchRegion, isSearchRegion } from "./product-search";

describe("search regions", () => {
  // A shopper outside the list is searched as if in the US, in the wrong shops and currency.
  it("covers New Zealand and Australia, in their own currencies", () => {
    expect(SEARCH_REGIONS.find((r) => r.code === "NZ")).toEqual({ code: "NZ", name: "New Zealand", currency: "NZD" });
    expect(SEARCH_REGIONS.find((r) => r.code === "AU")).toEqual({ code: "AU", name: "Australia", currency: "AUD" });
  });

  it("guesses New Zealand from the request country, then the browser language", () => {
    expect(guessSearchRegion("nz", "en-US")).toBe("NZ");
    expect(guessSearchRegion(null, "en-NZ")).toBe("NZ");
  });

  it("falls back to the US for a country it cannot search", () => {
    expect(isSearchRegion("ZZ")).toBe(false);
    expect(guessSearchRegion("ZZ", "xx")).toBe("US");
  });
});
