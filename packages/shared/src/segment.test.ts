import { describe, expect, it } from "vitest";
import { applyMatchConditions } from "./match";
import { findPrices, matchPageSegments, segmentPage } from "./segment";

/**
 * A listing page holding one cheap accessory and one expensive laptop — the
 * shape that produced the false alerts this module exists to stop.
 */
const LISTING = `
Results for laptop
[Laptop sleeve 13 inch](https://shop.test/sleeve)
£24.99
In stock
[MacBook Pro M4 Max 16 inch](https://shop.test/mbp)
£3,499.00
In stock
[Refurbished ThinkPad X1](https://shop.test/x1)
£450.00
In stock
`;

describe("segmentPage", () => {
  it("gives one block per link and drops the chrome above the first", () => {
    const segments = segmentPage(LISTING);
    expect(segments.map((s) => s.url)).toEqual([
      "https://shop.test/sleeve",
      "https://shop.test/mbp",
      "https://shop.test/x1",
    ]);
    expect(segments[0]!.text).not.toContain("Results for laptop");
    expect(segments[1]!.text).toContain("£3,499.00");
  });

  it("treats a page with no links as a single block", () => {
    const segments = segmentPage("Out of stock");
    expect(segments).toEqual([{ url: null, title: "", text: "Out of stock" }]);
  });

  it("takes the entry title from the link text", () => {
    expect(segmentPage(LISTING).map((s) => s.title)).toEqual([
      "Laptop sleeve 13 inch",
      "MacBook Pro M4 Max 16 inch",
      "Refurbished ThinkPad X1",
    ]);
  });
});

describe("findPrices", () => {
  it("reads non-dollar currencies", () => {
    expect(findPrices("£24.99 and €1,200 and $3.50 and 99 USD")).toEqual([
      24.99, 1200, 3.5, 99,
    ]);
  });
});

describe("matchPageSegments", () => {
  it("does not pair one entry's keyword with another entry's price", () => {
    const matches = matchPageSegments(LISTING, {
      mustInclude: ["macbook"],
      priceMax: 500,
    });
    expect(matches).toEqual([]);
  });

  it("still matches when both facts come from the same entry", () => {
    const matches = matchPageSegments(LISTING, {
      mustInclude: ["macbook"],
      priceMax: 4000,
    });
    expect(matches.map((m) => m.url)).toEqual(["https://shop.test/mbp"]);
    expect(matches[0]!.pricesInRange).toEqual([3499]);
  });

  it("rejects an entry carrying no price when a price filter is set", () => {
    const matches = matchPageSegments(
      `[Sold out item](https://shop.test/a)\nCurrently unavailable\n[Other](https://shop.test/b)\n£10`,
      { mustInclude: ["sold out"], priceMax: 100 }
    );
    expect(matches).toEqual([]);
  });

  it("falls back to page-level prices when no entry carries one", () => {
    // Price sits above the link that names the item, so no block holds both.
    const matches = matchPageSegments(
      `£299\n[Nice Chair](https://shop.test/chair)\nFree delivery`,
      { mustInclude: ["chair"], priceMax: 400 }
    );
    expect(matches.map((m) => m.url)).toEqual(["https://shop.test/chair"]);
  });

  it("reads the link target for includes but not for excludes", () => {
    // Listing markup truncates link text, so the slug is often the only place
    // the full title survives; an exclude firing on one drops a wanted listing.
    const page = `[Red kettle](https://shop.test/black-friday/kettle)\n£40`;
    expect(matchPageSegments(page, { mustInclude: ["black"] })).toHaveLength(1);
    expect(matchPageSegments(page, { mustExclude: ["black"] })).toHaveLength(1);
  });

  it("matches a title that only the link target spells out in full", () => {
    const page = `[A Light in the ...](https://books.test/a-light-in-the-attic_1000/)\n£51.77`;
    const matches = matchPageSegments(page, { mustInclude: ["light-in-the-attic"], priceMax: 60 });
    expect(matches).toHaveLength(1);
  });

  it("honours excludes within the entry", () => {
    const matches = matchPageSegments(LISTING, {
      mustInclude: ["thinkpad"],
      mustExclude: ["refurbished"],
    });
    expect(matches).toEqual([]);
  });
});

describe("applyMatchConditions", () => {
  it("does not match a keyword against a field name", () => {
    const items = [{ title: "Blue hat", price: 10, url: "https://shop.test/hat" }];
    expect(applyMatchConditions(items, { mustInclude: ["price"] })).toEqual([]);
    expect(applyMatchConditions(items, { mustExclude: ["url"] })).toEqual(items);
  });

  it("drops an item with no price when a price filter is set", () => {
    const items = [{ title: "Mystery box", price: null, url: "https://shop.test/x" }];
    expect(applyMatchConditions(items, { priceMax: 50 })).toEqual([]);
    expect(applyMatchConditions(items, {})).toEqual(items);
  });
});
