import { describe, expect, test } from "vitest";
import { isArticlePage, isComparisonSite, isProductMonitor, productExcerpt, productItem } from "./product";

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

  // Prod, 15/11/2026: the search's title was "PowerColor Reaper Radeon RX
  // 9060 XT 16GB"; PB Tech writes "Powercolor Reaper AMD Radeon RX 9060 XT
  // 16GB GDDR6". The exact search missed, the fallback found the empty cart's
  // $0.00, and every product read came back with no price or stock.
  test("finds a title whose words appear together in another order or with extra words", () => {
    const page = `Brands PowerColor Cart $0.00 ${"nav ".repeat(100)}Powercolor Reaper AMD Radeon RX 9060 XT 16GB GDDR6 $799.00 Out of stock`;
    const { excerpt, matched } = productExcerpt(page, "PowerColor Reaper Radeon RX 9060 XT 16GB");
    expect(matched).toBe(true);
    expect(excerpt).toContain("$799.00 Out of stock");
  });

  // A short word must not match inside another, such as "11" in "$1,119".
  test("matches title words whole, not inside other words or prices", () => {
    const page = `Apple iPad Air 13 M2 $1,119 ${"z ".repeat(200)} Apple iPad Air M2 11-inch $899 In stock`;
    const { excerpt, matched } = productExcerpt(page, "Apple iPad Air 11 M2");
    expect(matched).toBe(true);
    expect(excerpt).toContain("$899 In stock");
    expect(excerpt.startsWith("Apple iPad Air 13")).toBe(false);
  });

  // A false match is worse than a miss: the monitor then hashes only the
  // wrong slice and stops re-reading on page changes. Found in review, 15/11/2026.
  test("does not match a short title on navigation", () => {
    const page = `Sony Bose | Headphones Speakers ${"nav ".repeat(300)} Sony WH-1000XM5 Wireless Headphones $299`;
    expect(productExcerpt(page, "Sony headphones").matched).toBe(false);
  });

  test("does not take a title's words from two neighbouring products", () => {
    const page = "Apple iPad Air 11 M3 $999 | Apple iPad Air 13 M2 $1,119";
    expect(productExcerpt(page, "Apple iPad Air 11 M2").matched).toBe(false);
  });

  test("keeps one-letter words, so Series X does not match Series S", () => {
    const page = "Microsoft Xbox Series S 1TB Console $499 In stock";
    expect(productExcerpt(page, "Microsoft Xbox Series X 1TB Console").matched).toBe(false);
  });

  test("ignores punctuation stuck to a title word", () => {
    const page = `${"nav ".repeat(100)}Sony WH-1000XM5 Headphones (Black) $299 In stock`;
    expect(productExcerpt(page, "Sony WH-1000XM5, Black").matched).toBe(true);
  });

  test("does not match title words scattered across the page", () => {
    const page = `PowerColor ${"x ".repeat(400)} Reaper ${"y ".repeat(400)} Radeon RX 9060 XT 16GB $10`;
    expect(productExcerpt(page, "PowerColor Reaper Radeon RX 9060 XT 16GB").matched).toBe(false);
  });

  // Prod, 19/11/2026: Extreme PC prints the title in the breadcrumb, then in
  // the heading, then a hidden review form. The window from the breadcrumb
  // ended at "Now:", so every read found stock but never the price.
  test("starts at the title that has the price after it, not an earlier mention", () => {
    const form = "Rating Required Select Rating 1 star (worst) 5 stars (best) Name Email Required ".repeat(8);
    const title = "Kingston NV3 1TB M.2 NVMe Internal SSD-PCIe Gen 4";
    const page = `Menu [Home] [${title}] [Kingston] ${title} (No reviews yet) ${form}${title} Auckland Stock: 5+ in stock Now: $319.00`;
    for (const search of [title, "Kingston NV3 1TB M.2 NVMe SSD PCIe Gen 4"]) {
      const { excerpt, matched } = productExcerpt(page, search);
      expect(matched).toBe(true);
      expect(excerpt).toContain("Now: $319.00");
    }
  });

  // "$31" read from a cut "$319.00" is a wrong price, worse than none.
  test("does not count a price cut off at the window's edge", () => {
    const title = "Sony WH-1000XM5";
    const pad = "x".repeat(700 - title.length - 1 - "$31".length);
    const page = `${title} ${pad}$319.00 Out of stock`.replace(`${pad}$319`, `${pad.slice(0, -title.length - 1)}${title} $319`);
    expect(page.indexOf("$319") + "$31".length).toBe(700);
    expect(productExcerpt(page, title).excerpt).toContain("$319.00");
  });

  // A page with no price near any mention keeps today's excerpt, so its hash
  // does not move and buy a re-read.
  test("falls back to the first mention when none has a price after it", () => {
    const page = `Sony WH-1000XM5 ${"x ".repeat(500)} Sony WH-1000XM5 Out of stock`;
    expect(productExcerpt(page, "Sony WH-1000XM5").excerpt.startsWith("Sony WH-1000XM5 x")).toBe(true);
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
      "https://nz.pcpartpicker.com/product/abc/gigabyte-b650i-ax",
      "https://www.geizhals.de/a123.html",
      "https://www.kelkoo.co.uk/c-1-x",
      "https://www.ledenicheur.fr/product.php?p=1",
      "https://www.trovaprezzi.it/prezzo_x.aspx",
      "https://tweakers.net/pricewatch/1/x.html",
      "https://www.google.com/shopping/product/1",
      "https://shopping.google.co.uk/x",
    ]) {
      expect(isComparisonSite(url), url).toBe(true);
    }
  });

  test("leaves shops alone, including ones whose name contains a comparison site's", () => {
    for (const url of ["https://www.pbtech.co.nz/product/1", "https://notpricespy.com/x", "https://shopping.example.com/p/1", "https://www.google.com/search?q=x", "not a url"]) {
      expect(isComparisonSite(url), url).toBe(false);
    }
  });
});

describe("isArticlePage", () => {
  // Prod, 14/11/2026: a product got box.co.uk/blog/... as a shop page.
  test("knows blog, news, review and guide pages by their path", () => {
    for (const url of [
      "https://www.box.co.uk/blog/steam-machine-release-date",
      "https://www.currys.co.uk/techtalk/news/1",
      "https://shop.test/reviews/sony-xm5",
      "https://shop.test/articles/x",
    ]) {
      expect(isArticlePage(url), url).toBe(true);
    }
  });

  test("leaves product pages alone, including ones whose slug holds such a word", () => {
    for (const url of [
      "https://www.pbtech.co.nz/product/VGA1/x",
      "https://shop.test/products/news-print-paper",
      "https://shop.test/p/review-kit",
      // Shops that sell magazines and printed guides file them so.
      "https://shop.test/magazine/issue-12",
      "https://shop.test/guides/lonely-planet-nz",
      "nope",
    ]) {
      expect(isArticlePage(url), url).toBe(false);
    }
  });
});
