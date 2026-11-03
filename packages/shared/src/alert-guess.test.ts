import { describe, expect, it } from "vitest";
import { guessAlertOn } from "./alert-guess";

// A clone pre-fills a product's alerts from these guesses. A wrong one sets
// the wrong alert, and the user may never notice.
describe("guessAlertOn", () => {
  it("reads restock intent", () => {
    for (const prompt of [
      "Tell me when it's back in stock",
      "Alert me on restock",
      "restocked in size 10",
      "in stock again",
      "when it comes back",
      "email me when available",
      "when it's in stock",
    ]) {
      expect(guessAlertOn(prompt).backInStock, prompt).toBe(true);
    }
  });

  it("does not read stock words that aren't a restock wish", () => {
    for (const prompt of [
      "available in size M",
      "Out of stock",
      "Alert if it's no longer in stock",
      "when it's not available",
      "Unavailable colours are fine",
    ]) {
      expect(guessAlertOn(prompt).backInStock, prompt).toBe(false);
    }
  });

  it("reads a target price with its currency", () => {
    expect(guessAlertOn("Sony WH-1000XM5 under £300").priceBelow).toMatchObject({ amount: 300, currency: "GBP" });
    expect(guessAlertOn("below €1,299.99").priceBelow).toMatchObject({ amount: 1299.99, currency: "EUR" });
    expect(guessAlertOn("less than 500 USD").priceBelow).toMatchObject({
      amount: 500,
      currency: "USD",
      written: "500 USD",
    });
    expect(guessAlertOn("under A$80").priceBelow).toMatchObject({ amount: 80, currency: "AUD" });
  });

  it("skips a number with no currency and finds the price later on", () => {
    expect(guessAlertOn("Size under 10, alert me below £250").priceBelow).toMatchObject({
      amount: 250,
      currency: "GBP",
    });
  });

  it("keeps a shared symbol for the user to settle", () => {
    expect(guessAlertOn("MacBook under $1,500").priceBelow).toEqual({
      amount: 1500,
      currency: null,
      symbol: "$",
      written: "$1,500",
    });
  });

  it("ignores numbers with no currency, or a word that only looks like a code", () => {
    expect(guessAlertOn("under 300 grams").priceBelow).toBeNull();
    expect(guessAlertOn("less than 50 cup sizes").priceBelow).toBeNull();
  });

  it("reads any price drop, unless a target was given", () => {
    for (const prompt of [
      "tell me if the price drops",
      "when the price falls",
      "let me know when it gets cheaper",
      "when it goes on sale",
      "on sale",
    ]) {
      expect(guessAlertOn(prompt).priceDrop, prompt).toBe(true);
    }
    expect(guessAlertOn("cheaper than £50").priceDrop).toBe(false);
  });

  it("reads nothing from cheaper than a bare number", () => {
    expect(guessAlertOn("cheaper than 50")).toMatchObject({ priceDrop: false, priceBelow: null });
  });

  it("guesses nothing from a prompt that names no alert", () => {
    expect(guessAlertOn("Blue running shoes size 10")).toEqual({
      backInStock: false,
      priceDrop: false,
      priceBelow: null,
    });
  });
});
