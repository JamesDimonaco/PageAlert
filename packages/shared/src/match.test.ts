import { describe, expect, it } from "vitest";
import { applyMatchConditions, explainMatch } from "./match";

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
