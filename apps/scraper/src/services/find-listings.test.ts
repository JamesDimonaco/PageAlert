import { describe, expect, it } from "vitest";
import { parseListings } from "./find-listings.js";

const listing = (overrides: Record<string, unknown> = {}) => ({
  site: "argos.co.uk",
  url: "https://www.argos.co.uk/product/123",
  title: "Sony WH-1000XM5",
  price: 279.99,
  currency: "GBP",
  inStock: true,
  label: "same",
  ...overrides,
});

const answer = (listings: unknown[]) => JSON.stringify({ listings });

// These results become monitors in ticket 07, so what gets through here is
// what the scheduler will later open and what alerts will quote.
describe("parseListings", () => {
  it("stores prices as integer minor units in the page's currency", () => {
    const [gbp, jpy] = parseListings(
      answer([listing(), listing({ url: "https://www.amazon.co.jp/dp/1", price: 45800, currency: "jpy" })])
    );
    expect(gbp).toMatchObject({ price: 27999, currency: "GBP" });
    expect(jpy).toMatchObject({ price: 45800, currency: "JPY" });
  });

  it("keeps one page per site, ignoring www.", () => {
    const result = parseListings(
      answer([
        listing({ url: "https://www.argos.co.uk/product/1" }),
        listing({ url: "https://argos.co.uk/product/2" }),
        listing({ url: "https://www.currys.co.uk/p/3" }),
      ])
    );
    expect(result.map((l) => l.url)).toEqual([
      "https://www.argos.co.uk/product/1",
      "https://www.currys.co.uk/p/3",
    ]);
    expect(result.map((l) => l.site)).toEqual(["argos.co.uk", "currys.co.uk"]);
  });

  it("drops non-web URLs and malformed entries but keeps the rest", () => {
    const result = parseListings(
      answer([
        listing({ url: "javascript:alert(1)" }),
        listing({ url: "not a url" }),
        listing({ url: "https://a.example/1", label: "bargain" }),
        listing({ url: "https://b.example/1", title: "" }),
        listing({ url: "https://c.example/1" }),
      ])
    );
    expect(result.map((l) => l.site)).toEqual(["c.example"]);
  });

  it("shows no price rather than a wrong one", () => {
    const [noCurrency, badCurrency, noPrice] = parseListings(
      answer([
        listing({ url: "https://a.example/1", currency: null }),
        listing({ url: "https://b.example/1", currency: "XYZ1" }),
        listing({ url: "https://c.example/1", price: "£279" }),
      ])
    );
    for (const l of [noCurrency, badCurrency, noPrice]) expect(l).toMatchObject({ price: null, currency: null });
  });

  it("returns at most 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => listing({ url: `https://shop${i}.example/p` }));
    expect(parseListings(answer(many))).toHaveLength(8);
  });

  it("fails when there is no answer to read, so the caller can refund the search", () => {
    expect(() => parseListings("Sorry, I could not search right now.")).toThrow();
    expect(() => parseListings('{"results": []}')).toThrow();
  });
});
