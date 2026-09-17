/**
 * Should we still be checking this monitor, given how long its owner has been
 * away?
 *
 * The whole inactivity reaper turns on this one pure function so the rules can
 * be tested without a Convex harness — every branch here is one off-by-one
 * away from silently stopping somebody's embassy-appointment watch, and
 * nothing downstream would notice.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long an owner has to be away before a monitor that has already alerted
 * them is paused.
 *
 * Not 14: a fortnight's holiday is normal, and a false positive lands on
 * exactly the engaged user we least want to lose. Not 60: the last-seen
 * histogram of live-monitor owners is bimodal — 9 seen inside 30 days, 45 seen
 * 50+ days ago, nobody in between — so anything from 30 to 50 pauses the same
 * people today, and 30 stops the leak a month sooner for the next cohort.
 */
export const DORMANT_AFTER_MS = 30 * DAY_MS;

/**
 * How long an owner has to be away before a monitor is paused regardless of
 * whether it ever matched.
 *
 * A monitor that has never matched is not yet proven useless, and it is also
 * the shape of a visa-appointment watch where silence is the expected state,
 * so it gets a quarter rather than a month.
 */
export const LONG_GONE_AFTER_MS = 90 * DAY_MS;

/**
 * How old the ignored alert has to be before it counts as ignored. Stops
 * "matched at 08:00, paused at 10:00" on the same morning and gives a fresh
 * alert a chance to be acted on.
 */
export const IGNORED_ALERT_GRACE_MS = 3 * DAY_MS;

/** How long a pause email's restart link works for. After that, sign in. */
export const RESUME_TOKEN_TTL_MS = 90 * DAY_MS;

/** "keep" means carry on checking. The other two name the rule that fired. */
export type DormancyVerdict = "keep" | "ignored-alert" | "long-gone";

export type DormancyInput = {
  now: number;
  /** See `lastSeenFrom`. */
  lastSeenAt: number;
  lastMatchAt?: number;
  /** Undefined means parked — the scheduler has already stopped checking it. */
  nextCheckAt?: number;
  status: string;
  isAnonymous?: boolean;
  isPaying: boolean;
  /**
   * This monitor's alerts go nowhere: it is muted, or its channel list is
   * empty. `lastMatchAt` is stamped on every new match regardless (see
   * recordCheckResult), so without this rule A fires on an alert the user was
   * never sent, and the pause email's premise is a lie.
   */
  alertsSuppressed?: boolean;
};

/**
 * When we last have evidence this user was here.
 *
 * Every input is a moment the user was demonstrably present, so the newest
 * wins. Assembling it needs care because the obvious signal is the one that
 * disappears: Better Auth deletes a session row on sign-out, and deletes an
 * expired one the next time any page loads. So a user who signs out, or who
 * comes back after their cookie expired and bounces off the login page, leaves
 * no session at all — and read alone, the session table would call someone who
 * was reading an alert last week "never seen since signup".
 */
export function lastSeenFrom(signals: {
  /** Our own stamp, written when the dashboard loads. The only one nothing deletes. */
  touchedAt?: number;
  /** Newest Better Auth session.updatedAt, i.e. last opened the app. */
  sessionAt?: number;
  signupAt?: number;
  /** Newest monitor this user created, from the creation log. */
  monitorCreatedAt?: number;
  /** Last press of Restart in a pause email. Signs nobody in, so nothing else records it. */
  resumedAt?: number;
}): number {
  return Math.max(
    signals.touchedAt ?? 0,
    signals.sessionAt ?? 0,
    signals.signupAt ?? 0,
    signals.monitorCreatedAt ?? 0,
    signals.resumedAt ?? 0,
  );
}

export function dormancyVerdict(input: DormancyInput): DormancyVerdict {
  const { now, lastSeenAt, lastMatchAt, nextCheckAt, status, isAnonymous, isPaying, alertsSuppressed } = input;

  // Not live: already paused or mid-scan, so there is nothing to stop.
  if (status !== "active" && status !== "error") return "keep";
  // Parked costs nothing already, and pausing it would lose the parked state —
  // on resume it would come back with no nextCheckAt and never run again.
  if (nextCheckAt === undefined) return "keep";
  if (isAnonymous) return "keep";
  if (isPaying) return "keep";

  const away = now - lastSeenAt;

  // Rule A: the monitor did its job, told them, and they never came back.
  if (
    away >= DORMANT_AFTER_MS &&
    !alertsSuppressed &&
    lastMatchAt !== undefined &&
    lastMatchAt > lastSeenAt &&
    now - lastMatchAt >= IGNORED_ALERT_GRACE_MS
  ) {
    return "ignored-alert";
  }

  // Rule B: gone long enough that nothing it finds will be read.
  if (away >= LONG_GONE_AFTER_MS) return "long-gone";

  return "keep";
}
