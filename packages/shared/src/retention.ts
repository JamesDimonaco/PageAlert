import { DAY_MS } from "./dormancy";
import type { TierName } from "./subscription";

/**
 * How far back each tier can read its own scrape logs.
 *
 * This is a window on to the data, not a lifetime: nothing is deleted, so an
 * upgrade makes the older checks readable again the moment it lands, and a
 * downgrade hides them rather than destroying them.
 *
 * Deleting the account does remove them — see deleteScrapeLogs in
 * convex/account.ts. Only the reading is gated.
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

/** The longest window sold. Nothing older than this is readable on any plan. */
export const MAX_HISTORY_WINDOW_DAYS = Math.max(...Object.values(HISTORY_WINDOW_DAYS));

/** The oldest timestamp `tier` may read. Rows stamped at or after it are theirs. */
export function historyCutoff(tier: TierName, now: number): number {
  return now - HISTORY_WINDOW_DAYS[tier] * DAY_MS;
}

/**
 * Inclusive at the cutoff: a row stamped exactly one window ago still counts,
 * so "7 days" means seven and not six.
 *
 * Nothing caps the other end. Today every createdAt is written by Date.now()
 * inside a Convex mutation, so a future stamp cannot happen; if a backfill or
 * an import ever writes one, showing it beats hiding it.
 */
export function isWithinHistoryWindow(stampedAt: number, tier: TierName, now: number): boolean {
  return stampedAt >= historyCutoff(tier, now);
}
