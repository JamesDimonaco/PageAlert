import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  DORMANT_AFTER_MS,
  IGNORED_ALERT_GRACE_MS,
  LONG_GONE_AFTER_MS,
  RESUME_TOKEN_TTL_MS,
  dormancyVerdict,
  lastSeenFrom,
  type DormancyInput,
} from "./dormancy";

const NOW = Date.UTC(2026, 8, 18, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

/**
 * The thresholds themselves, in real units.
 *
 * Every other test here is written as `NOW - DORMANT_AFTER_MS`, so it moves
 * with the constant and stays green however the constant changes. Those tests
 * pin the comparisons; these pin the values. Each number is a product decision
 * argued out in the doc comments on the constants — how long someone can be
 * away before we stop checking the page they are waiting on. Changing one
 * should mean reading that argument, not watching a suite stay green.
 */
describe("the thresholds", () => {
  it("counts a day as 24 hours", () => {
    expect(DAY_MS).toBe(86_400_000);
  });

  it("pauses an alerted monitor after 30 days away", () => {
    expect(DORMANT_AFTER_MS).toBe(30 * 86_400_000);
  });

  it("pauses a never-matched monitor after 90 days away", () => {
    expect(LONG_GONE_AFTER_MS).toBe(90 * 86_400_000);
  });

  it("gives an alert 3 days before it counts as ignored", () => {
    expect(IGNORED_ALERT_GRACE_MS).toBe(3 * 86_400_000);
  });

  it("keeps a pause email's restart link working for 90 days", () => {
    expect(RESUME_TOKEN_TTL_MS).toBe(90 * 86_400_000);
  });

  it("is more patient with a monitor that never matched", () => {
    // The ordering is the actual rule: silence is the expected state for a
    // visa-appointment watch, so it must not be reaped on the shorter clock.
    expect(LONG_GONE_AFTER_MS).toBeGreaterThan(DORMANT_AFTER_MS);
  });
});

/** A live monitor whose owner has been gone 40 days and ignored an alert. */
function input(overrides: Partial<DormancyInput> = {}): DormancyInput {
  return {
    now: NOW,
    lastSeenAt: NOW - 40 * DAY,
    lastMatchAt: NOW - 10 * DAY,
    nextCheckAt: NOW + DAY,
    status: "active",
    isPaying: false,
    ...overrides,
  };
}

describe("rule A — the alert nobody came back for", () => {
  it("pauses a monitor that alerted after the owner was last seen", () => {
    expect(dormancyVerdict(input())).toBe("ignored-alert");
  });

  it("keeps a monitor whose owner has been away less than 30 days", () => {
    const lastSeenAt = NOW - DORMANT_AFTER_MS + 1;
    expect(dormancyVerdict(input({ lastSeenAt, lastMatchAt: lastSeenAt + 1 }))).toBe("keep");
  });

  it("pauses exactly on the 30-day boundary", () => {
    const lastSeenAt = NOW - DORMANT_AFTER_MS;
    expect(dormancyVerdict(input({ lastSeenAt, lastMatchAt: lastSeenAt + 1 }))).toBe("ignored-alert");
  });

  it("keeps a monitor whose last match predates the owner's last visit", () => {
    // They saw the alert and came back afterwards. Nothing was ignored.
    expect(dormancyVerdict(input({ lastMatchAt: NOW - 45 * DAY }))).toBe("keep");
  });

  it("keeps a monitor that has never matched", () => {
    expect(dormancyVerdict(input({ lastMatchAt: undefined }))).toBe("keep");
  });

  it("holds off until the alert is 3 days old", () => {
    const lastMatchAt = NOW - IGNORED_ALERT_GRACE_MS + 1;
    expect(dormancyVerdict(input({ lastMatchAt }))).toBe("keep");
    expect(dormancyVerdict(input({ lastMatchAt: NOW - IGNORED_ALERT_GRACE_MS }))).toBe("ignored-alert");
  });

  it("takes precedence over rule B, so the email can say why", () => {
    expect(dormancyVerdict(input({ lastSeenAt: NOW - 200 * DAY }))).toBe("ignored-alert");
  });
});

describe("rule B — long gone", () => {
  const never = { lastMatchAt: undefined };

  it("keeps a never-matched monitor until 90 days", () => {
    expect(dormancyVerdict(input({ ...never, lastSeenAt: NOW - LONG_GONE_AFTER_MS + 1 }))).toBe("keep");
  });

  it("pauses exactly on the 90-day boundary", () => {
    expect(dormancyVerdict(input({ ...never, lastSeenAt: NOW - LONG_GONE_AFTER_MS }))).toBe("long-gone");
  });

  it("pauses a monitor whose only match was before the owner's last visit", () => {
    const lastSeenAt = NOW - 100 * DAY;
    expect(dormancyVerdict(input({ lastSeenAt, lastMatchAt: lastSeenAt - DAY }))).toBe("long-gone");
  });
});

describe("skips", () => {
  const gone = { lastSeenAt: NOW - 200 * DAY, lastMatchAt: NOW - 10 * DAY };

  it("never pauses a paying owner's monitor", () => {
    expect(dormancyVerdict(input({ ...gone, isPaying: true }))).toBe("keep");
  });

  it("never pauses a parked monitor", () => {
    // Pausing would lose the parked state, and on resume it would come back
    // with no nextCheckAt and never run again.
    expect(dormancyVerdict(input({ ...gone, nextCheckAt: undefined }))).toBe("keep");
  });

  it("never pauses an anonymous monitor", () => {
    expect(dormancyVerdict(input({ ...gone, isAnonymous: true }))).toBe("keep");
  });

  it("leaves an already-paused monitor alone, so manual pauses stay manual", () => {
    expect(dormancyVerdict(input({ ...gone, status: "paused" }))).toBe("keep");
  });

  it("leaves a scanning monitor alone", () => {
    expect(dormancyVerdict(input({ ...gone, status: "scanning" }))).toBe("keep");
  });

  it("still pauses a monitor sitting in the error lane", () => {
    expect(dormancyVerdict(input({ ...gone, status: "error" }))).toBe("ignored-alert");
  });
});

describe("alerts that went nowhere", () => {
  // lastMatchAt is stamped on every new match, even for a monitor whose alerts
  // are all switched off. Rule A would then pause it 60 days early on the
  // strength of an alert the user was never sent.
  it("does not treat a muted monitor's match as an ignored alert", () => {
    expect(dormancyVerdict(input({ alertsSuppressed: true }))).toBe("keep");
  });

  it("still pauses a silent monitor once its owner is long gone", () => {
    expect(dormancyVerdict(input({ alertsSuppressed: true, lastSeenAt: NOW - 100 * DAY }))).toBe("long-gone");
  });
});

describe("lastSeenFrom", () => {
  // The session row is the signal that disappears — Better Auth deletes it on
  // sign-out and deletes an expired one on the next page load. Every test here
  // is a user who was demonstrably present but has no session to prove it.
  it("takes the newest signal, whichever it is", () => {
    expect(lastSeenFrom({ signupAt: 100, sessionAt: 300, monitorCreatedAt: 200 })).toBe(300);
    expect(lastSeenFrom({ signupAt: 100, sessionAt: 50, monitorCreatedAt: 200 })).toBe(200);
  });

  it("keeps our own stamp when the session row has been deleted", () => {
    expect(lastSeenFrom({ touchedAt: NOW - DAY, signupAt: NOW - 200 * DAY })).toBe(NOW - DAY);
  });

  it("counts a restart from a pause email, which signs nobody in", () => {
    // Without this the next day's run pauses the monitor again, one email a day.
    expect(lastSeenFrom({ resumedAt: NOW - DAY, signupAt: NOW - 200 * DAY })).toBe(NOW - DAY);
  });

  it("falls back to signup for a user with no session at all", () => {
    expect(lastSeenFrom({ signupAt: NOW - 5 * DAY })).toBe(NOW - 5 * DAY);
  });

  it("is 0 when nothing is known, so the caller can tell", () => {
    expect(lastSeenFrom({})).toBe(0);
  });
});
