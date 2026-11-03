import { describe, expect, test } from "vitest";
import { productExcerpt, toMinorUnits } from "./product";

// A wrong scale stores a price 100× off, and ticket 05's "below £X" alert
// then fires on the wrong side of the target.
describe("toMinorUnits", () => {
  test("two-decimal currencies, including a float that does not multiply cleanly", () => {
    expect(toMinorUnits(12.99, "GBP")).toBe(1299);
    expect(toMinorUnits(19.99, "USD")).toBe(1999);
    expect(toMinorUnits(1299, "EUR")).toBe(129900);
  });

  test("currencies without two decimals use their own scale", () => {
    expect(toMinorUnits(1500, "JPY")).toBe(1500);
    expect(toMinorUnits(1.234, "KWD")).toBe(1234);
  });

  // An unreadable price must stay unknown, never become 0 — a "free" product
  // would sit below every target.
  test("an unreadable price or currency is null", () => {
    expect(toMinorUnits("£12.99", "GBP")).toBeNull();
    expect(toMinorUnits(Number.NaN, "GBP")).toBeNull();
    expect(toMinorUnits(-1, "GBP")).toBeNull();
    expect(toMinorUnits(12.99, "£")).toBeNull();
    expect(toMinorUnits(12.99, null)).toBeNull();
  });
});

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
