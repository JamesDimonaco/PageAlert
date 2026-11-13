import { expect, test } from "vitest";
import { checkFailureKind, matchKey, NEVER_SUCCEEDED_RETRY_DAYS } from "./shared";

// The blocked-first-scan toast promises this many days of retries before the
// park email. If it moves, re-read that toast and the park email together.
test("a never-read monitor keeps retrying for 7 days before it parks", () => {
  expect(NEVER_SUCCEEDED_RETRY_DAYS).toBe(7);
});

// check_failed groups by this in PostHog, so each real failure must land in its own bucket.
test("a failed check is named by what went wrong", () => {
  expect(checkFailureKind("Fallback provider error: ERR::ASP::SHIELD_PROTECTION_FAILED blocked", false)).toBe("proxy_provider");
  expect(checkFailureKind("Site is blocking automated access: HTTP 403.", false)).toBe("blocked");
  expect(checkFailureKind("AI service error 401: authentication error", false)).toBe("ai_billing");
  expect(checkFailureKind("Page took too long to load", true)).toBe("timeout");
  expect(checkFailureKind("Scraper error: HTTP 500", false)).toBe("other");
});

// An item with no url or title is keyed by a hash of itself. The stock read
// can flip between true and null across reads; that must not make it new.
test("a keyless item keeps its key when only its stock read changes", () => {
  const key = (inStock?: boolean | null): string => {
    const item: Record<string, unknown> = { description: "16GB DDR5-6000", price: 199 };
    if (inStock !== undefined) item.inStock = inStock;
    return matchKey(item);
  };
  expect(key(null)).toBe(key(true));
  expect(key(false)).toBe(key());
});
