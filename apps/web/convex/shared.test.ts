import { expect, test } from "vitest";
import {
  checkFailureKind,
  isProxyFloored,
  matchKey,
  NEVER_SUCCEEDED_RETRY_DAYS,
  PARK_REASON_PAGE_GONE,
  parkMessage,
  parkReasonOf,
} from "./shared";

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
  expect(checkFailureKind("Page not found (HTTP 404). The shop may have removed or moved it.", false)).toBe("page_gone");
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

// Email and push get the whole sentence. The monitor page has its own title
// and a Retry button, so it shows the reason alone. If the two drift, the
// page prints "Checks have stopped." under a title that already says so.
test("the monitor page can take the reason back out of a park message", () => {
  const message = parkMessage(PARK_REASON_PAGE_GONE);
  expect(message).toBe(`Checks have stopped. ${PARK_REASON_PAGE_GONE} Use Retry to try again.`);
  expect(parkReasonOf(message)).toBe(PARK_REASON_PAGE_GONE);
  expect(parkReasonOf("Page took too long to load")).toBe("Page took too long to load");
});

// The card and the monitor page both print the interval. A site we can only
// read through the proxy runs every 6 hours whatever the user picked, and
// both screens must say so.
test("a proxy-only monitor on a faster interval is held at the floor", () => {
  expect(isProxyFloored({ checkInterval: "1h", proxyPreferred: true })).toBe(true);
  expect(isProxyFloored({ checkInterval: "5m", proxyPreferred: true })).toBe(true);
  expect(isProxyFloored({ checkInterval: "6h", proxyPreferred: true })).toBe(false);
  expect(isProxyFloored({ checkInterval: "24h", proxyPreferred: true })).toBe(false);
  expect(isProxyFloored({ checkInterval: "15m" })).toBe(false);
});
