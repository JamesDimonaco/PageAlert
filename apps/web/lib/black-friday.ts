/** The Polar discount: 50% off the first payment on every plan, Sprint included. */
export const BLACK_FRIDAY_CODE = "BLACKFRIDAY50";

/** Midnight US Pacific at the end of 30 November 2026, when the Polar code stops working. */
export const BLACK_FRIDAY_ENDS_AT = Date.UTC(2026, 11, 1, 8);

export function isBlackFridayLive(now: number): boolean {
  return now < BLACK_FRIDAY_ENDS_AT;
}
