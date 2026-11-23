import { describe, expect, it } from "vitest";
import { SEARCH_REGIONS, guessSearchRegion, isSearchRegion, regionForPage } from "./product-search";

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

// Turning a monitor into a product searches other shops in one country. The
// wrong one fills the product with shops that will not sell to the user.
describe("regionForPage", () => {
  it("keeps the saved region when its currency matches the page", () => {
    expect(regionForPage("EUR", "IE", "https://www.amazon.de/x")).toBe("IE");
    expect(regionForPage(undefined, "NZ", "https://shop.test/x")).toBe("NZ");
  });

  it("goes by the page's currency when the saved region prices in another", () => {
    expect(regionForPage("GBP", "US", "https://shop.test/x")).toBe("GB");
    expect(regionForPage("AUD", null, "https://shop.test/x")).toBe("AU");
  });

  it("breaks a shared currency by the domain ending", () => {
    expect(regionForPage("EUR", "GB", "https://www.fnac.fr/x")).toBe("FR");
    expect(regionForPage("EUR", null, "https://www.amazon.de/x")).toBe("DE");
    expect(regionForPage(undefined, null, "https://www.argos.co.uk/x")).toBe("GB");
  });

  // With no price read yet the currency is unknown, and a country domain says
  // more about where the shop sells than where the user last searched.
  it("prefers a country domain over the saved region when the currency is unknown", () => {
    expect(regionForPage(undefined, "US", "https://www.amazon.co.uk/x")).toBe("GB");
  });

  it("falls back to the first region for the currency, then the US", () => {
    expect(regionForPage("EUR", null, "https://shop.com/x")).toBe("IE");
    expect(regionForPage(undefined, null, "https://shop.com/x")).toBe("US");
    expect(regionForPage("JPY", null, "not a url")).toBe("US");
  });
});
