import { describe, expect, it } from "vitest";
import { guessAlertOn } from "./alert-guess";

// A clone pre-fills a product's alerts from these guesses. A wrong one sets
// the wrong alert, and the user may never notice.
describe("guessAlertOn", () => {
  it("reads back in stock", () => {
    expect(guessAlertOn("Tell me when it's in stock").backInStock).toBe(true);
    expect(guessAlertOn("Alert me on restock").backInStock).toBe(true);
    expect(guessAlertOn("When size 10 is available").backInStock).toBe(true);
    expect(guessAlertOn("Unavailable colours are fine").backInStock).toBe(false);
  });

  it("reads a target price with its currency", () => {
    expect(guessAlertOn("Sony WH-1000XM5 under £300").priceBelow).toEqual({ amount: 300, currency: "GBP" });
    expect(guessAlertOn("below €1,299.99").priceBelow).toEqual({ amount: 1299.99, currency: "EUR" });
    expect(guessAlertOn("less than 500 USD").priceBelow).toEqual({ amount: 500, currency: "USD" });
    expect(guessAlertOn("under A$80").priceBelow).toEqual({ amount: 80, currency: "AUD" });
  });

  it("leaves the currency to the user when the symbol is shared", () => {
    expect(guessAlertOn("MacBook under $1500").priceBelow).toEqual({ amount: 1500, currency: null });
  });

  it("ignores numbers with no currency, or a word that only looks like a code", () => {
    expect(guessAlertOn("under 300 grams").priceBelow).toBeNull();
    expect(guessAlertOn("less than 50 cup sizes").priceBelow).toBeNull();
  });

  it("reads any price drop, unless a target was given", () => {
    expect(guessAlertOn("tell me if the price drops").priceDrop).toBe(true);
    expect(guessAlertOn("let me know when it gets cheaper").priceDrop).toBe(true);
    expect(guessAlertOn("cheaper than £50").priceDrop).toBe(false);
  });

  it("guesses nothing from a prompt that names no alert", () => {
    expect(guessAlertOn("Blue running shoes size 10")).toEqual({
      backInStock: false,
      priceDrop: false,
      priceBelow: null,
    });
  });
});
