import { describe, expect, it } from "vitest";
import { applyMatchConditions, explainMatch, stockNotShownNote } from "./match";

const terra = {
  title: "Fractal Design Terra Mini ITX Case - Jade",
  price: 379,
  currency: "NZD",
  stock: "Unavailable / In Stock",
};

describe("explainMatch", () => {
  // The Terra monitor showed "0 matches" with no reason. The reason has to
  // name the failing condition and the value that failed it.
  it("names the price that failed and the limit it missed", () => {
    const checks = explainMatch(terra, { priceMin: 0, priceMax: 350, mustInclude: ["Fractal", "Terra"] });
    expect(checks).toEqual([
      { kind: "price", min: 0, max: 350, price: 379, pass: false },
      { kind: "mustInclude", word: "Fractal", pass: true },
      { kind: "mustInclude", word: "Terra", pass: true },
    ]);
  });

  // One row per word, so the user sees which word is missing, not just "keywords failed".
  it("reports each keyword on its own", () => {
    const checks = explainMatch(
      { title: "Sony WH-1000XM5", colour: "Black" },
      { titleContains: ["sony", "xm4"], titleExcludes: ["refurb"], mustInclude: ["silver"], mustExclude: ["black"] },
    );
    expect(checks).toEqual([
      { kind: "titleContains", word: "sony", pass: true },
      { kind: "titleContains", word: "xm4", pass: false },
      { kind: "titleExcludes", word: "refurb", pass: true },
      { kind: "mustInclude", word: "silver", pass: false },
      { kind: "mustExclude", word: "black", pass: false },
    ]);
  });

  it("passes a price exactly on the limit", () => {
    expect(explainMatch({ title: "x", price: 350 }, { priceMax: 350 })[0].pass).toBe(true);
    expect(explainMatch({ title: "x", price: 350 }, { priceMin: 350 })[0].pass).toBe(true);
    expect(explainMatch({ title: "x", price: 349.99 }, { priceMin: 350 })[0].pass).toBe(false);
  });

  // A price filter must not wave through items it cannot read a price for.
  it("fails the price check when the item has no readable price", () => {
    expect(explainMatch({ title: "x", price: "NZ$329" }, { priceMax: 350 })).toEqual([
      { kind: "price", min: undefined, max: 350, price: undefined, pass: false },
    ]);
  });

  it("returns no checks when there are no conditions", () => {
    expect(explainMatch(terra, {})).toEqual([]);
  });
});

describe("applyMatchConditions", () => {
  // The page, the Items tab and the scraper all filter through this. It must
  // keep exactly the items whose every check passes.
  it("keeps only items where every check passes", () => {
    const cheap = { ...terra, title: "Fractal Terra Graphite", price: 329 };
    const items = [terra, cheap, { title: "NZXT H1", price: 300 }];
    expect(applyMatchConditions(items, { priceMax: 350, mustInclude: ["Fractal", "Terra"] })).toEqual([cheap]);
  });

  it("keeps everything when there are no conditions", () => {
    expect(applyMatchConditions([terra], {})).toEqual([terra]);
  });
});

// Prod, 12/11/2026: "PC build: 16GB DDR5-6000 RAM" asked for "in stock at
// NZ$220 or less" and alerted on a sold-out kit at NZ$199.
describe("stock", () => {
  const kingston = {
    title: "Kingston FURY Beast 16GB DDR5-6000",
    price: 199,
    currency: "NZD",
    stock: "Out of Stock",
    inStock: false,
  };
  const asksStock = { priceMax: 220, mustInclude: ["Kingston"], inStockOnly: true };

  it("never matches a sold-out item when the prompt asks for stock", () => {
    expect(applyMatchConditions([kingston], asksStock)).toEqual([]);
    expect(explainMatch(kingston, asksStock)).toContainEqual({ kind: "stock", inStock: false, pass: false });
  });

  it("matches the same item once it is back in stock", () => {
    const back = { ...kingston, stock: "In Stock", inStock: true };
    expect(applyMatchConditions([back], asksStock)).toEqual([back]);
  });

  // Honest unknown: the page does not say, so the item may match, marked "not shown".
  it("lets an item through when the page does not show stock, and says so", () => {
    const unknown = { ...kingston, stock: null, inStock: null };
    expect(applyMatchConditions([unknown], asksStock)).toEqual([unknown]);
    expect(explainMatch(unknown, asksStock)).toContainEqual({ kind: "stock", inStock: null, pass: true });
  });

  // Items saved before inStock existed have no field at all.
  it("reads a missing inStock field as not shown", () => {
    const { inStock: _drop, ...old } = kingston;
    expect(explainMatch(old, asksStock)).toContainEqual({ kind: "stock", inStock: null, pass: true });
  });

  it("ignores stock when the prompt does not ask for it", () => {
    expect(applyMatchConditions([kingston], { priceMax: 220 })).toEqual([kingston]);
    expect(explainMatch(kingston, { priceMax: 220 }).some((c) => c.kind === "stock")).toBe(false);
  });
});

describe("stockNotShownNote", () => {
  const asks = { inStockOnly: true };
  const shown = { title: "Noctua NH-L9a-AM5", inStock: true };
  const hidden = { title: "Noctua NH-L9a-AM5 chromax", inStock: null };

  // A match alert must not read as "in stock" when the page never said so.
  it("names the one item whose stock the page did not show", () => {
    expect(stockNotShownNote([shown, hidden], asks)).toBe("Stock not shown on page for “Noctua NH-L9a-AM5 chromax”.");
  });

  it("counts them when there are several", () => {
    expect(stockNotShownNote([hidden, { ...hidden, title: "Other" }, shown], asks)).toBe(
      "Stock not shown on page for 2 of these matches.",
    );
  });

  it("says nothing when stock was not asked for, or every match showed it", () => {
    expect(stockNotShownNote([hidden], {})).toBeNull();
    expect(stockNotShownNote([shown], asks)).toBeNull();
  });

  // Quick-check matches have no inStock field: the scorer already judged stock
  // from the entry's text, so the alert must not claim it was not shown.
  it("says nothing for matches that were judged without a stock field", () => {
    expect(stockNotShownNote([{ title: "Noctua NH-L9a-AM5", matchScore: 90 }], asks)).toBeNull();
  });
});
