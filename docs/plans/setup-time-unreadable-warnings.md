# Warn at setup when a page may never be readable

**Recommendation:** warn, never block. Two changes to the create flow, both client-side copy plus one pure function:

1. **Session-bound URL warning.** When the pasted URL carries a query param that only makes sense inside one browser session (`CSRFToken`, `sessionid`, `X-Amz-Signature` and so on), show an inline warning on the form before the scan runs: the link belongs to your browser session and will stop working, so paste the page you land on *before* the form steps instead.
2. **Honest blocked-scan toast.** When the initial scan is blocked, replace "We'll automatically retry" with what actually happens: we keep trying for about a week, most blocked sites come good, and we email you if it never does.

Status: **proposed**, not started. Keep the monitor in both cases; James chose warn-and-keep over blocking creation or parking early.

## Why

A user set up two monitors on the US embassy appointment calendar (`evisaforms.state.gov/acs/make_calendar.asp?CSRFToken=…&pc=KWT`, and the Egypt equivalent). All 106 checks failed (CAPTCHA, Cloudflare, timeouts), each monitor ran for weeks, and the first thing the user heard was the park email. The create flow already knew the first scan was blocked and said only "We'll automatically retry".

## What the data says (prod, 2026-09-24)

| Signal | Count | What it means |
|---|---|---|
| Monitors live | 69 | |
| Never had a successful check | 9 (8 parked in `error`) | evisaforms ×2, rei, westmarine, paulsmith, bestbuy, calvinklein.de, mazeclothing |
| URL has a session-like query param | 2 | both evisaforms, both never succeeded |
| First logged check was a bot wall | 41 of 168 monitors in `scrapeLogs` | |
| ...and later succeeded at least once | **25 of 41 (61%)** | some after hundreds of checks (instagram.com: 421) |

The 61% is why this plan warns and doesn't block: a blocked first scan is a bad predictor on its own. Blocking creation would have turned away 25 monitors that went on to work. `scrapeLogs` is capped by tier retention, so early churned monitors are under-counted.

A session-bound URL is a much stronger signal: even if we get past the WAF, the token belongs to someone else's session. The sample is two monitors from one user, so treat that as reasoning, not evidence.

## How it works today (origin/main @ 776b40b)

- `monitors.create` inserts the monitor as `scanning` with a real `nextCheckAt` before any scrape (`apps/web/convex/monitors.ts:224-237`).
- A blocked initial scan goes through `saveScanError`, which flips the monitor to `active`, `retryCount: 1`, retry in 30s (`monitors.ts:337-366`). The toast is at `apps/web/hooks/use-create-monitor.tsx:290-296`.
- Retries: 3 fast (`Math.pow(4, retryCount) * 30_000`, `scheduler.ts:260`), then the 6h recovery lane (`ERROR_RECOVERY_INTERVAL_MS`). A never-succeeded monitor parks at `MAX_NEVER_SUCCEEDED_RETRIES = 32` (`shared.ts`), about 8 days, and the stopped-checks alert goes out on email, Telegram, Discord and push (`scheduler.ts:877-925`). The evisaforms rows reached 49 because a manual Retry resets `retryCount`.
- Nothing inspects query params on the monitor URL. `validateMonitorUrl` (`shared.ts:139-179`) checks length, protocol and private hosts only. `packages/shared/src/url-identity.ts:16` has a `VOLATILE_PARAMS` list (`session|sessionid|jsessionid|phpsessid`), but it serves item identity, not the monitor URL.

## The change

### 1. `sessionBoundParams(url): string[]`

A pure function in `packages/shared/src` that returns the query keys that look session-bound, case-insensitive:

`csrftoken, csrf, _csrf, token, authenticity_token, session, sessionid, sid, jsessionid, phpsessid, auth, signature, x-amz-signature, x-amz-credential, expires`

Before adding a second list, check whether `VOLATILE_PARAMS` should become the one source. They answer different questions (is this item the same item vs will this URL keep working), so two lists may be right, but decide it on purpose.

`sid` and `token` will false-positive on some shop URLs. That costs one dismissible warning, which is acceptable because nothing is blocked.

### 2. Form warning

In the create form, when `sessionBoundParams` is non-empty, show an inline warning under the URL field naming the params. The user can still submit. Copy draft:

> This link includes `CSRFToken`, which belongs to your browser session. We won't be able to open it later. Try the page you reach before any form steps.

### 3. Blocked-scan toast copy

Replace the current toast with copy that states the timeline. Draft:

> This site blocked our first look. That often clears up, so we'll keep trying for about a week and email you if we never get in.

Tie "about a week" to `MAX_NEVER_SUCCEEDED_RETRIES` and `ERROR_RECOVERY_INTERVAL_MS` in a comment, or derive it, so the copy can't drift from the constants.

## Tests (write first)

- `sessionBoundParams` unit test: the real evisaforms URL returns `["CSRFToken"]`; a signed S3 URL returns its signature params; a plain Amazon product URL returns `[]`; key matching is case-insensitive. Mutation-check by dropping a key from the list.
- If the toast derives "about a week" from the constants, a test pins that 32 × 6h rounds to a week.

No test for the form rendering itself; it's a conditional `<p>`.

## Out of scope

- Blocking creation or parking early (the 61% says no).
- Suggesting a rewritten URL. We can't know which page precedes the session step.
- A "never read yet" state on the dashboard card. Worth checking what the card shows for `checkCount: 0, retryCount > 0` first; if it already reads as broken, nothing to do.
- Getting into appointment portals at all. That's PROWL-036 (appointment monitoring) in James's vault, `projects/prowl/tickets/`.
