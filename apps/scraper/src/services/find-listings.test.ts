import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { parseListings, SearchFailure, searchFailureReason } from "./find-listings.js";

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

  it("reads the answer past narration that has braces of its own", () => {
    const text = `I'll search for {Sony WH-1000XM5} in UK shops.\n\nHere is what I found:\n${answer([listing()])}`;
    expect(parseListings(text).map((l) => l.site)).toEqual(["argos.co.uk"]);
  });

  it("reads the answer when a note after it has braces", () => {
    const text = `${answer([listing()])}\n\nPrices checked at 09:00 {GMT}.`;
    expect(parseListings(text).map((l) => l.site)).toEqual(["argos.co.uk"]);
  });

  it("fails when there is no answer to read, so the caller can refund the search", () => {
    expect(() => parseListings("Sorry, I could not search right now.")).toThrow(SearchFailure);
    expect(() => parseListings('{"results": []}')).toThrow(SearchFailure);
  });

  // The reason reaches PostHog, so a failed search says why without reading logs.
  it("names why the answer could not be read", () => {
    const reason = (text: string) => {
      try {
        parseListings(text);
      } catch (error) {
        return searchFailureReason(error);
      }
    };
    expect(reason("Sorry, I could not search right now.")).toBe("no_json");
    expect(reason('{"results": []}')).toBe("no_json");
    expect(reason('{"listings": "none"}')).toBe("bad_shape");
  });
});

describe("searchFailureReason", () => {
  it("tells a timeout, an Anthropic error and an unknown crash apart", () => {
    // What the SDK throws when the search budget's AbortSignal fires.
    expect(searchFailureReason(new Anthropic.APIUserAbortError())).toBe("timeout");
    expect(searchFailureReason(new Anthropic.APIConnectionTimeoutError())).toBe("timeout");
    expect(searchFailureReason(new Anthropic.APIError(529, undefined, "Overloaded", new Headers()))).toBe("ai_error");
    expect(searchFailureReason(new TypeError("x is undefined"))).toBe("unknown");
  });
});
