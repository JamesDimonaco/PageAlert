import { DAY_MS } from "./dormancy";
import type { TierName } from "./subscription";

/**
 * How far back each tier can read its own scrape logs.
 *
 * This is a window on to the data, not a lifetime: nothing is deleted, so an
 * upgrade makes the older checks readable again the moment it lands, and a
 * downgrade hides them rather than destroying them. Support can still see
 * everything, which is the whole reason for keeping them.
 *
 * The numbers are sold on the pricing page — lib/plans.ts reads them from
 * here so the cards cannot drift from what the server actually serves, which
 * is what happened the last time the two were written out separately.
 */
export const HISTORY_WINDOW_DAYS: Record<TierName, number> = {
  free: 7,
  sprint: 30,
  pro: 60,
  max: 90,
};

/** The oldest timestamp `tier` may read. Rows stamped at or after it are theirs. */
export function historyCutoff(tier: TierName, now: number): number {
  return now - HISTORY_WINDOW_DAYS[tier] * DAY_MS;
}

/**
 * Inclusive both ends: a row stamped exactly one window ago still counts, and
 * so does one stamped slightly in the future — the scraper and Convex keep
 * their own clocks, and a few seconds of skew must not hide the check that
 * just ran.
 */
export function isWithinHistoryWindow(stampedAt: number, tier: TierName, now: number): boolean {
  return stampedAt >= historyCutoff(tier, now);
}
