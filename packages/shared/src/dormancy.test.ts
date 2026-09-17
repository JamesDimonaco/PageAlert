import { describe, expect, it } from "vitest";
import {
  DORMANT_AFTER_MS,
  IGNORED_ALERT_GRACE_MS,
  LONG_GONE_AFTER_MS,
  dormancyVerdict,
  type DormancyInput,
} from "./dormancy";

const NOW = Date.UTC(2026, 8, 18, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

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

describe("last seen falls back to signup and monitor creation", () => {
  // Better Auth deletes the session row on sign-out, so a user with no session
  // is signed out, not absent. The caller passes the newest of signup time and
  // monitor creation instead; these pin that a recent one of those saves them.
  it("keeps a monitor created 5 days ago by a user with no session", () => {
    expect(dormancyVerdict(input({ lastSeenAt: NOW - 5 * DAY, lastMatchAt: NOW - DAY }))).toBe("keep");
  });

  it("pauses when signup and monitor creation are both over 90 days old", () => {
    expect(dormancyVerdict(input({ lastSeenAt: NOW - 120 * DAY, lastMatchAt: undefined }))).toBe("long-gone");
  });
});
