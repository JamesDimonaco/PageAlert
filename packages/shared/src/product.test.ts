import { describe, expect, test } from "vitest";
import { isComparisonSite, isProductMonitor, productExcerpt, productItem } from "./product";

describe("productExcerpt", () => {
  // Churn outside the buy box must not change the excerpt, or every check
  // pays for a re-read.
  test("starts at the title and stops before far-off page text", () => {
    const page = `[Home](https://shop.test/)\nSony WH-1000XM5\n£299.00\nOut of stock\n${"x".repeat(1000)}\nRecently viewed: 3`;
    const { excerpt, matched } = productExcerpt(page, "Sony  WH-1000XM5");
    expect(matched).toBe(true);
    expect(excerpt).toContain("Out of stock");
    expect(excerpt).not.toContain("Recently viewed");
  });

  // Shops print typographic dashes and quotes where the AI's copy of the
  // title has plain ones. A miss here drops the monitor to whole-page reads.
  test("finds a title whose dashes, quotes and case differ from the page", () => {
    const page = "Menu\nAPPLE IPAD PRO 11\u2033 \u2013 SPACE GREY\u2122\nIn stock";
    const { excerpt, matched } = productExcerpt(page, 'Apple iPad Pro 11" - Space Grey');
    expect(matched).toBe(true);
    expect(excerpt.startsWith("Menu APPLE IPAD PRO")).toBe(true);
  });

  // A tracking token in a link changes on every load; left in, it would
  // re-bill the product on every check.
  test("drops link targets", () => {
    expect(productExcerpt("Sony WH-1000XM5 [Add to basket](https://shop.test/cart?t=abc123)", "Sony WH-1000XM5").excerpt)
      .toBe("Sony WH-1000XM5 [Add to basket]");
  });

  // An unmatched title must still give the reader something with a price in
  // it, and say so, so the caller can fall back to whole-page changes.
  test("without the title, says so and starts near the first price", () => {
    const page = `${"nav ".repeat(200)}Headphones £299.00 Out of stock`;
    const { excerpt, matched } = productExcerpt(page, "Sony WH-1000XM5");
    expect(matched).toBe(false);
    expect(excerpt).toContain("£299.00 Out of stock");
  });
});

// Prod, 13/11/2026: the Computer Lounge Noctua page holds the product plus 8
// "You may also like" items. Counting items alone said "listing", so stock
// and price alerts could never run on it.
describe("productItem", () => {
  const page = "https://computerlounge.co.nz/products/noctua-nh-l9a-am5-cpu-cooler";
  const noctua = { title: "Noctua NH-L9a-AM5 Low Profile CPU Cooler", price: 89, url: page };
  const related = [
    { title: "Noctua NH-L9a-AM5 Chromax Black", price: 99, url: "https://computerlounge.co.nz/products/noctua-nh-l9a-am5-chromax-black-cpu-cooler" },
    { title: "Noctua NH-L12S", price: 109, url: "https://computerlounge.co.nz/products/noctua-nh-l12s-low-profile-cpu-cooler-w-nf-a12x15-pwm" },
  ];

  test("picks the item that links to the page itself, wherever it sits", () => {
    expect(productItem({ items: [...related, noctua] }, page)).toEqual(noctua);
  });

  // Shops add tracking params; identity must survive them.
  test("matches the page through tracking params", () => {
    expect(productItem({ items: [noctua, ...related] }, `${page}?utm_source=pricespy`)).toEqual(noctua);
  });

  test("falls back to a lone item when none links to the page", () => {
    const lone = { title: "Sony WH-1000XM5", url: null };
    expect(productItem({ items: [lone] }, "https://shop.test/xm5")).toEqual(lone);
  });

  // A listing must stay a listing: its related items are the point.
  test("is null on a listing, where no item links to the page", () => {
    expect(productItem({ items: related }, "https://computerlounge.co.nz/collections/coolers")).toBeNull();
  });

  // Two items claiming the page is not one product.
  test("is null when two items link to the page", () => {
    expect(productItem({ items: [noctua, { ...noctua, title: "dup" }] }, page)).toBeNull();
  });

  // Prod, 14/11/2026: two PriceSpy pages with one layout read as 1 item and
  // as 4. Its items are shops' offers, so the count says nothing about the page.
  test("is null on a price comparison page, however many items it reads as", () => {
    const pricespy = "https://pricespy.co.nz/product.php?p=7327471";
    expect(productItem({ items: [{ title: "AMD Ryzen 5 7600", price: 46198, url: null }] }, pricespy)).toBeNull();
    expect(productItem({ items: [{ title: "x", url: pricespy }] }, pricespy)).toBeNull();
  });

  test("makes a related-items product page a product monitor", () => {
    expect(isProductMonitor({ url: page, schema: { items: [noctua, ...related] } })).toBe(true);
    expect(isProductMonitor({ url: "https://computerlounge.co.nz/collections/coolers", schema: { items: related } })).toBe(false);
  });
});

describe("isComparisonSite", () => {
  test("knows the comparison sites in the search regions, on any subdomain or country domain", () => {
    for (const url of [
      "https://pricespy.co.nz/product.php?p=5023628",
      "https://www.priceme.co.nz/Gigabyte-RX-9060-XT/p-123.aspx",
      "https://www.pricerunner.com/pl/1-2/x",
      "https://www.idealo.de/preisvergleich/OffersOfProduct/1.html",
      "https://www.staticice.com.au/cgi-bin/search.cgi?q=x",
    ]) {
      expect(isComparisonSite(url), url).toBe(true);
    }
  });

  test("leaves shops alone, including ones whose name contains a comparison site's", () => {
    for (const url of ["https://www.pbtech.co.nz/product/1", "https://notpricespy.com/x", "not a url"]) {
      expect(isComparisonSite(url), url).toBe(false);
    }
  });
});
