import { describe, expect, it } from "vitest";
import { formatMinorUnits, fromMinorUnits, toMinorUnits } from "./money";

// Prices are stored as integers. A wrong exponent turns ¥1,500 into ¥150,000
// or £12.99 into £1,299 on every alert that quotes it.
describe("toMinorUnits", () => {
  it("uses the currency's own exponent", () => {
    expect(toMinorUnits(12.99, "GBP")).toBe(1299);
    expect(toMinorUnits(1500, "JPY")).toBe(1500);
    expect(toMinorUnits(1.234, "KWD")).toBe(1234);
  });

  it("rounds away float noise rather than truncating it", () => {
    // 19.99 * 100 is 1998.9999999999998 in floating point.
    expect(toMinorUnits(19.99, "USD")).toBe(1999);
  });

  it("refuses what it cannot convert honestly", () => {
    expect(toMinorUnits(10, "NOPE")).toBeNull();
    // Well-formed but not ISO 4217; Intl would format them happily.
    expect(toMinorUnits(10, "UKP")).toBeNull();
    expect(toMinorUnits(10, "RMB")).toBeNull();
    expect(toMinorUnits(-1, "GBP")).toBeNull();
    expect(toMinorUnits(Number.NaN, "GBP")).toBeNull();
  });
});

// Price alerts quote old and new prices. A hard-coded $ or a fixed two
// decimals would show a UK user dollars, or a Japanese price 100× too small.
describe("formatMinorUnits", () => {
  it("shows the currency's own symbol and decimals", () => {
    expect(formatMinorUnits(1299, "GBP")).toBe("£12.99");
    expect(formatMinorUnits(1500, "JPY")).toBe("¥1,500");
  });

  it("refuses an unknown currency rather than showing dollars", () => {
    expect(formatMinorUnits(1299, "UKP")).toBeNull();
  });
});

// A saved target is shown back in its edit field. A wrong exponent there turns
// £12.99 into 1299, which saving again would store as £1,299.
describe("fromMinorUnits", () => {
  it("undoes toMinorUnits in the currency's own exponent", () => {
    expect(fromMinorUnits(1299, "GBP")).toBe(12.99);
    expect(fromMinorUnits(1500, "JPY")).toBe(1500);
    expect(fromMinorUnits(1234, "KWD")).toBe(1.234);
    expect(fromMinorUnits(1299, "UKP")).toBeNull();
  });
});
