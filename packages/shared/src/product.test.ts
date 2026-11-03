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
  // pays for a re-score.
  test("starts at the title and stops before far-off page text", () => {
    const page = `[Home](https://shop.test/)\nSony WH-1000XM5\n£299.00\nOut of stock\n${"x".repeat(3000)}\nRecently viewed: 3`;
    const excerpt = productExcerpt(page, "Sony  WH-1000XM5");
    expect(excerpt).toContain("Out of stock");
    expect(excerpt).not.toContain("Recently viewed");
  });

  // A tracking token in a link changes on every load; left in, it would
  // re-bill the product on every check.
  test("drops link targets", () => {
    expect(productExcerpt("Sony WH-1000XM5 [Add to basket](https://shop.test/cart?t=abc123)", "Sony WH-1000XM5"))
      .toBe("Sony WH-1000XM5 [Add to basket]");
  });

  test("is null when the title is not on the page", () => {
    expect(productExcerpt("Something else entirely", "Sony WH-1000XM5")).toBeNull();
  });
});
