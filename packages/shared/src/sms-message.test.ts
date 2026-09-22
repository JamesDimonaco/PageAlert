import { describe, it, expect } from "vitest";
import {
  GSM7_SEGMENT_LIMIT,
  fit,
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

  /**
   * Which form an alert takes is decided by `variant OR variant OR count === 1`.
   * Every case below has a count other than one, or a variant of "multiple",
   * so each leg of that condition is load-bearing on its own — with one change
   * and a naming variant, all three legs agree and the branch is untested.
   */
  it("names the crossing item when a threshold fires on several", () => {
    const changes = [
      { title: "Sony WH-1000XM5", oldPrice: 379, newPrice: 279.99, changePercent: -26.1 },
      { title: "Bose QC45", oldPrice: 329, newPrice: 299, changePercent: -9.1 },
    ];
    const body = formatPriceSms({ monitorName: "Headphones", variant: "threshold", changes, link: LINK });
    expect(body).toContain("price target hit");
    expect(body).toContain("Sony WH-1000XM5");
    assertOneSegment(body);
  });

  it("names the dropped item when a single_drop arrives with others", () => {
    const changes = [
      { title: "Sony WH-1000XM5", oldPrice: 379, newPrice: 279.99, changePercent: -26.1 },
      { title: "Bose QC45", oldPrice: 329, newPrice: 299, changePercent: -9.1 },
    ];
    const body = formatPriceSms({ monitorName: "Headphones", variant: "single_drop", changes, link: LINK });
    expect(body).toContain("Sony WH-1000XM5 now $279.99");
    assertOneSegment(body);
  });

  it("names the item when 'multiple' turns out to carry exactly one", () => {
    const body = formatPriceSms({
      monitorName: "Headphones",
      variant: "multiple",
      changes: [drop],
      link: LINK,
    });
    expect(body).toContain("Sony WH-1000XM5 now $279.99");
    expect(body).not.toContain("price change");
    assertOneSegment(body);
  });

  it("handles an empty change list without throwing", () => {
    const body = formatPriceSms({ monitorName: "Headphones", variant: "multiple", changes: [], link: LINK });
    assertOneSegment(body);
    expect(body).toContain("0 price changes");
  });
});

/**
 * `fit` decides where a message stops, and every boundary below is one septet
 * from doubling the cost of every alert that hits it. Asserting exact output
 * rather than "short enough", because "short enough" passes whatever the
 * boundary happens to be.
 */
describe("fit", () => {
  it("returns text untouched when it exactly fills the budget", () => {
    expect(fit("abcd", 4)).toBe("abcd");
  });

  it("marks the cut when there is room for a marker", () => {
    expect(fit("abcdef", 4)).toBe("ab..");
  });

  it("drops the marker below four septets rather than losing all the content", () => {
    expect(fit("abcdef", 3)).toBe("abc");
    expect(fit("abcdef", 1)).toBe("a");
  });

  it("gives nothing back when there is no room at all", () => {
    expect(fit("abcdef", 0)).toBe("");
    expect(fit("abcdef", -5)).toBe("");
  });

  it("counts an extended character as the two septets it costs", () => {
    // "[" is escape-prefixed, so only one fits in the two septets left after
    // the marker. Counting it as one would put the message over its segment.
    expect(fit("[[[[", 4)).toBe("[..");
  });

  it("fills the budget exactly rather than stopping a character early", () => {
    expect(fit("abcdefgh", 6)).toBe("abcd..");
  });
});

describe("the segment boundary is exact, not approximate", () => {
  it("fills a truncated match alert to exactly 160 septets", () => {
    // One unbroken token, so the cut lands mid-word and nothing is trimmed —
    // this is the case that reaches the limit exactly.
    const body = formatMatchSms({
      monitorName: "Supercalifragilistic".repeat(10),
      newCount: 7,
      link: LINK,
    });
    // Not "<= 160": a limit of 161 would satisfy that too, and 161 septets is
    // two segments and twice the price of every alert that hits it.
    expect(gsm7Length(body)).toBe(GSM7_SEGMENT_LIMIT);
    expect(gsm7Length(body)).toBe(160);
  });

  it("leaves a name alone when it already fits, however close to the limit", () => {
    const monitorName = "A monitor name long enough that it has to be cut short to fit the message";
    const body = formatMatchSms({ monitorName, newCount: 7, link: LINK });
    expect(body).toContain(monitorName);
    expect(body).not.toContain("..");
    assertOneSegment(body);
  });
});

describe("the fixed-copy messages", () => {
  it("fits the quota notice in one segment at every tier's allowance", () => {
    for (const limit of [10, 25, 60, 200]) {
      assertOneSegment(formatQuotaExhaustedSms(limit));
    }
  });

  it("names the allowance that ran out", () => {
    expect(formatQuotaExhaustedSms(10)).toContain("10");
    expect(formatQuotaExhaustedSms(200)).toContain("200");
  });

  it("fits the verification code in one segment", () => {
    assertOneSegment(formatVerificationSms("481920"));
  });
});
