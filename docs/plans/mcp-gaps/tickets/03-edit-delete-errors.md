# 03: One error shape, plus update_monitor and delete_monitor

**What to build:** Agents can edit and delete monitors, and every tool fails with `{ code, message, retry }`.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Codes: blocked, limit_reached, not_found, invalid_url, failed.
- [x] `update_monitor`: name, prompt, interval (clamped to plan), alertOn, paused. A URL change is refused with a reason.
- [x] `delete_monitor`, marked destructive.
- [x] `create_monitor` takes alertOn, or guesses it from the prompt. Results say when stock and price alerts cannot run because the page is a listing.
