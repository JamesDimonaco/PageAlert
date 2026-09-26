import { expect, test } from "vitest";
import { NEVER_SUCCEEDED_RETRY_DAYS } from "./shared";

// The blocked-first-scan toast promises this many days of retries before the
// park email. If it moves, re-read that toast and the park email together.
test("a never-read monitor keeps retrying for 7 days before it parks", () => {
  expect(NEVER_SUCCEEDED_RETRY_DAYS).toBe(7);
});
