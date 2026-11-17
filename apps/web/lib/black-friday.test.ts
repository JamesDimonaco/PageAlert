import { describe, expect, it } from "vitest";
import { BLACK_FRIDAY_CODE, BLACK_FRIDAY_ENDS_AT, isBlackFridayLive } from "./black-friday";

// The banner must not advertise a code Polar has stopped accepting.
describe("Black Friday banner", () => {
  it("ends at midnight US Pacific at the end of 30 November, when the Polar code stops", () => {
    expect(new Date(BLACK_FRIDAY_ENDS_AT).toISOString()).toBe("2026-12-01T08:00:00.000Z");
  });

  it("shows until the last millisecond and hides from the end on", () => {
    expect(isBlackFridayLive(BLACK_FRIDAY_ENDS_AT - 1)).toBe(true);
    expect(isBlackFridayLive(BLACK_FRIDAY_ENDS_AT)).toBe(false);
  });

  it("names the code set up in Polar", () => {
    expect(BLACK_FRIDAY_CODE).toBe("BLACKFRIDAY50");
  });
});
