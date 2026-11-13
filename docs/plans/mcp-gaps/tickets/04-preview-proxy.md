# 04: Preview gets one proxy attempt, 5 per user per day

**What to build:** When a site blocks `preview_page`, it retries once through the proxy.

**Blocked by:** 03

**Status:** done

- [x] Capped at 5 per user per UTC day, 20 an hour across all previews, and the fleet's monthly proxy budget.
- [x] Previews do not draw on the monitors' hourly escalation budget.
- [x] Past a cap: `blocked`, `retry: false`, with the reason.
