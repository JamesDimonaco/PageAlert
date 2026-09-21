import { describe, it, expect } from "vitest";
import {
  GSM7_SEGMENT_LIMIT,
  formatMatchSms,
  formatPriceSms,
  formatQuotaExhaustedSms,
  formatVerificationSms,
  gsm7Length,
  toGsm7,
} from "./sms-message";

/**
 * Every assertion here guards the same thing: one segment, GSM-7 only. Past
 * either boundary Twilio charges twice for the same alert, and nothing in the
 * type system can express "this string is short enough once encoded".
 */

const LINK = "https://pagealert.io/m/k17d8h2n4p9q3r5s7t1v6w8x0y2z4a6b";

function assertOneSegment(body: string) {
  expect(gsm7Length(body)).toBeLessThanOrEqual(GSM7_SEGMENT_LIMIT);
  expect(toGsm7(body)).toBe(body);
}

describe("toGsm7", () => {
  it("passes the basic alphabet through untouched", () => {
    expect(toGsm7("Ryanair deals 50% off - book now!")).toBe("Ryanair deals 50% off - book now!");
  });

  it("keeps accented letters the alphabet actually has", () => {
    expect(toGsm7("Caffè Öl Señor")).toBe("Caffè Öl Señor");
  });

  it("folds smart punctuation to its plain equivalent", () => {
    expect(toGsm7("“James’ pick” — today…")).toBe('"James\' pick" - today...');
  });

  it("strips accents it cannot represent rather than dropping the letter", () => {
    expect(toGsm7("Zoë Cătălin")).toBe("Zoe Catalin");
  });

  it("drops emoji instead of leaving placeholder noise", () => {
    expect(toGsm7("Flights ✈️🔥 cheap")).toBe("Flights cheap");
  });

  it("collapses exotic spaces so they cannot pad the length", () => {
    expect(toGsm7("a   b​c")).toBe("a bc");
  });
});

describe("gsm7Length", () => {
  it("bills extended characters as two septets", () => {
    expect(gsm7Length("abc")).toBe(3);
    expect(gsm7Length("[]{}")).toBe(8);
    expect(gsm7Length("€")).toBe(2);
  });
});

describe("formatMatchSms", () => {
  it("names the monitor and the count", () => {
    const body = formatMatchSms({ monitorName: "Ryanair deals", newCount: 3, link: LINK });
    expect(body).toBe(`PageAlert: 3 new matches on "Ryanair deals" ${LINK}`);
    assertOneSegment(body);
  });

  it("says match, not matches, for one", () => {
    const body = formatMatchSms({ monitorName: "Ryanair deals", newCount: 1, link: LINK });
    expect(body).toContain("1 new match on");
    expect(body).not.toContain("matches");
  });

  it("truncates a long name rather than spilling into a second segment", () => {
    const body = formatMatchSms({
      monitorName: "Cheap flights from Dublin to absolutely anywhere in continental Europe during the school holidays",
      newCount: 12,
      link: LINK,
    });
    assertOneSegment(body);
    expect(body).toContain("..");
    expect(body).toContain(LINK);
  });

  it("survives a name that is entirely unrepresentable", () => {
    const body = formatMatchSms({ monitorName: "🔥🔥🔥", newCount: 2, link: LINK });
    assertOneSegment(body);
    expect(body).toBe(`PageAlert: 2 new matches on "" ${LINK}`);
  });

  it("keeps the link whole even when the count runs to four digits", () => {
    const body = formatMatchSms({ monitorName: "A very long monitor name that will need cutting down", newCount: 9999, link: LINK });
    assertOneSegment(body);
    expect(body.endsWith(`" ${LINK}`)).toBe(true);
  });
});

describe("formatPriceSms", () => {
  const drop = { title: "Sony WH-1000XM5", oldPrice: 379, newPrice: 279.99, changePercent: -26.1 };

  it("names the price for a single drop", () => {
    const body = formatPriceSms({ monitorName: "Headphones", variant: "single_drop", changes: [drop], link: LINK });
    expect(body).toBe(`PageAlert: Sony WH-1000XM5 now $279.99 (was $379.00) ${LINK}`);
    assertOneSegment(body);
  });

  it("leads with the target for a threshold crossing", () => {
    const body = formatPriceSms({ monitorName: "Headphones", variant: "threshold", changes: [drop], link: LINK });
    expect(body).toContain("price target hit");
    assertOneSegment(body);
  });

  it("falls back to a count when several items moved", () => {
    const changes = Array.from({ length: 4 }, (_, i) => ({ ...drop, title: `Item ${i}` }));
    const body = formatPriceSms({ monitorName: "Headphones", variant: "multiple", changes, link: LINK });
    expect(body).toBe(`PageAlert: 4 price changes on "Headphones" ${LINK}`);
    assertOneSegment(body);
  });

  it("stays in one segment with a long item title", () => {
    const body = formatPriceSms({
      monitorName: "Headphones",
      variant: "single_drop",
      changes: [{ ...drop, title: "Sony WH-1000XM5 Wireless Industry Leading Noise Cancelling Headphones with Auto Noise Cancelling Optimizer" }],
      link: LINK,
    });
    assertOneSegment(body);
  });

  it("handles an empty change list without throwing", () => {
    const body = formatPriceSms({ monitorName: "Headphones", variant: "multiple", changes: [], link: LINK });
    assertOneSegment(body);
    expect(body).toContain("0 price changes");
  });
});

describe("the fixed-copy messages", () => {
  it("fits the quota notice in one segment", () => {
    assertOneSegment(formatQuotaExhaustedSms(10, "https://pagealert.io/dashboard/settings"));
    assertOneSegment(formatQuotaExhaustedSms(200, "https://pagealert.io/dashboard/settings"));
  });

  it("fits the verification code in one segment", () => {
    assertOneSegment(formatVerificationSms("481920"));
  });
});
