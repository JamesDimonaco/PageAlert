import { describe, expect, it } from "vitest";
import {
  MAX_LOG_NOTICES,
  MAX_LOG_NOTICE_BYTES,
  MAX_LOG_ROW_BYTES,
  MAX_LOG_TEXT_BYTES,
  MAX_MATCH_CONDITIONS_BYTES,
  MAX_RAW_RESPONSE_BYTES,
  capBytes,
  capLogFields,
  capRawResponse,
} from "./log-size";

const byteLen = (s: string) => new TextEncoder().encode(s).length;
/** A cut landing mid-sequence costs the ellipsis plus a replacement character. */
const SLACK = byteLen("…") + 3;

describe("capBytes", () => {
  it("leaves a string inside the budget alone", () => {
    expect(capBytes("hello", 100)).toBe("hello");
  });

  it("leaves a string exactly on the budget alone", () => {
    const exact = "x".repeat(50);
    expect(capBytes(exact, 50)).toBe(exact);
  });

  it("truncates one byte over", () => {
    expect(capBytes("x".repeat(51), 50)).not.toBe("x".repeat(51));
  });

  // The bug that shipped: a character-counted limit lets 200KB through.
  it("counts bytes, not characters", () => {
    const emoji = "🙂".repeat(50_000);
    expect(byteLen(emoji)).toBe(200_000);
    expect(byteLen(capBytes(emoji, MAX_RAW_RESPONSE_BYTES)))
      .toBeLessThanOrEqual(MAX_RAW_RESPONSE_BYTES + SLACK);
  });

  it("holds the budget when the cut lands mid-sequence", () => {
    for (const filler of ["あ", "√", "🙂", "x"]) {
      const wide = filler.repeat(40_000);
      expect(byteLen(capBytes(wide, 1_000))).toBeLessThanOrEqual(1_000 + SLACK);
    }
  });
});

describe("capRawResponse", () => {
  it("leaves undefined alone", () => {
    expect(capRawResponse(undefined)).toBeUndefined();
  });

  it("bounds whatever it is given", () => {
    expect(byteLen(capRawResponse("🙂".repeat(100_000))!))
      .toBeLessThanOrEqual(MAX_RAW_RESPONSE_BYTES + SLACK);
  });
});

/** Everything a caller can set, each one far past its budget. */
function hostileLog() {
  return {
    url: "https://example.com/".repeat(10_000),
    prompt: "🙂".repeat(100_000),
    error: "あ".repeat(100_000),
    rawResponse: "x".repeat(1_000_000),
    monitorName: "n".repeat(100_000),
    aiUnderstanding: "u".repeat(100_000),
    aiMatchSignal: "m".repeat(100_000),
    aiNoMatchSignal: "o".repeat(100_000),
    strategy: "s".repeat(100_000),
    blockReason: "b".repeat(100_000),
    aiNotices: Array.from({ length: 500 }, () => "notice".repeat(10_000)),
    matchConditions: { blob: "c".repeat(500_000) },
  };
}

describe("capLogFields", () => {
  // The claim MAX_LIST_LIMIT rests on. scrapeLogs is written by a public
  // mutation, so without this a signed-in caller decides what a row costs and
  // the logs page's read budget is fiction.
  it("brings a hostile row inside MAX_LOG_ROW_BYTES", () => {
    const capped = capLogFields(hostileLog());
    expect(byteLen(JSON.stringify(capped))).toBeLessThanOrEqual(MAX_LOG_ROW_BYTES);
  });

  it("bounds every text field to its budget", () => {
    const capped = capLogFields(hostileLog()) as Record<string, unknown>;
    for (const key of [
      "url", "prompt", "error", "monitorName", "aiUnderstanding",
      "aiMatchSignal", "aiNoMatchSignal", "strategy", "blockReason",
    ]) {
      expect(byteLen(capped[key] as string)).toBeLessThanOrEqual(MAX_LOG_TEXT_BYTES + SLACK);
    }
  });

  it("drops notices past the limit and bounds the ones it keeps", () => {
    const capped = capLogFields(hostileLog());
    expect(capped.aiNotices!.length).toBe(MAX_LOG_NOTICES);
    for (const n of capped.aiNotices!) {
      expect(byteLen(n)).toBeLessThanOrEqual(MAX_LOG_NOTICE_BYTES + SLACK);
    }
  });

  it("replaces match conditions too big to keep", () => {
    expect(capLogFields(hostileLog()).matchConditions).toEqual({ truncated: true });
  });

  it("leaves ordinary match conditions untouched", () => {
    const conditions = { keywords: ["macbook"], maxPrice: 1200 };
    expect(capLogFields({ url: "u", prompt: "p", matchConditions: conditions }).matchConditions)
      .toEqual(conditions);
  });

  it("leaves an ordinary row untouched", () => {
    const row = {
      url: "https://example.com/deals",
      prompt: "tell me when a refurbished 14in MacBook Pro drops below 1200",
      error: undefined,
      aiNotices: ["page needed the proxy"],
      matchConditions: { keywords: ["macbook"] },
    };
    expect(capLogFields(row)).toEqual(row);
  });

  it("keeps undefined optionals undefined rather than inventing them", () => {
    const capped = capLogFields({ url: "u", prompt: "p" });
    expect(capped.error).toBeUndefined();
    expect(capped.rawResponse).toBeUndefined();
    expect(capped.aiNotices).toBeUndefined();
    expect(capped.matchConditions).toBeUndefined();
  });

  it("agrees with the budget the constants add up to", () => {
    expect(MAX_LOG_ROW_BYTES).toBeGreaterThan(MAX_RAW_RESPONSE_BYTES + MAX_MATCH_CONDITIONS_BYTES);
  });
});
