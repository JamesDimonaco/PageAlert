# 01: Measure how often product pages change

**What to build:** A short note, added to this ticket, that says what re-scoring product pages will cost. Ticket 04 re-scores a single-product monitor with one AI call on every page change, so the cost depends on how often those pages change. Measure it from prod data before building.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Find the live monitors whose page holds a single product (one item in their last full extract).
- [ ] For each, count how often the content fingerprint changed per day over the last 30 days. Use the scrape logs or results.
- [ ] Report the median and 90th percentile changes per monitor per day.
- [ ] Estimate the monthly AI cost per product monitor, at today's scoring call price.
- [ ] Flag any site whose fingerprint changes on nearly every check, such as a timestamp or rotating ad in the page text. Those need a fix before ticket 04, or they cost a scoring call every check.
- [ ] Read-only: no data changes, and no temp exports left on disk (they hold user emails).
