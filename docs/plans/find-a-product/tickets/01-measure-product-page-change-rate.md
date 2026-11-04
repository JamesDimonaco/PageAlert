# 01: Measure how often product pages change

**What to build:** A short note, added to this ticket, that says what re-scoring product pages will cost. Ticket 04 re-scores a single-product monitor with one AI call on every page change, so the cost depends on how often those pages change. Measure it from prod data before building.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] Find the live monitors whose page holds a single product (one item in their last full extract).
- [x] For each, count how often the content fingerprint changed per day over the last 30 days. Use the scrape logs or results.
- [x] Report the median and 90th percentile changes per monitor per day.
- [x] Estimate the monthly AI cost per product monitor, at today's scoring call price.
- [x] Flag any site whose fingerprint changes on nearly every check, such as a timestamp or rotating ad in the page text. Those need a fix before ticket 04, or they cost a scoring call every check.
- [x] Read-only: no data changes, and no temp exports left on disk (they hold user emails).

## Findings (03/11/2026)

**Recommendation for ticket 04:** re-score only when the product's own entry text changes, not the whole-page fingerprint. Whole-page churn would bill most product pages on every check.

### Method (measured)

- Read prod with `npx convex data`, from `apps/web` in the main checkout. No writes. Exports were piped and the temp files deleted.
- Single-product monitor: `schema.items` (the last full AI extract) holds exactly one item. Prod has 17: 5 active, 10 paused, 2 in error.
- Source: `scrapeLogs`, last 30 days (04/10 to 03/11/2026). Every scheduled check writes one row. `strategy: "unchanged"` means the fingerprint matched, so no AI ran. Any other successful strategy means the fingerprint changed.
- The fingerprint is a SHA-256 of the whole page text, lowercased and whitespace-collapsed (`apps/scraper/src/utils/content-hash.ts`).
- 9 single-product monitors had checks in the window. Changes per day = changed checks ÷ days between first and last check.

### Change rate (measured)

| Group | Monitors | Median changes/day | p90 changes/day |
|---|---|---|---|
| Active single-product | 5 | 1.0 | 1.16 |
| All single-product with checks | 9 | 1.03 | 1.57 |

Most active product monitors run every 24h, so they cap at about 1 change a day. The rate per check says more:

- Share of checks where the fingerprint changed: median 0.67, p90 1.0 (8 monitors with more than one check).
- Only one page was mostly stable: outlet.arcteryx.com at 0.05.

The sample is small (9 monitors). Treat the numbers as rough.

### Cost (estimated)

- Scoring call: `scoreCandidates` in `apps/scraper/src/services/extractor.ts`, model `claude-sonnet-5`, thinking off.
- Price: $2 per million input tokens, $10 per million output. Source: the published Anthropic price table in the claude-api skill (cached 06/10/2026).
- Tokens per call for one product, estimated from the code: about 500 input (280 system prompt, plus prompt, title, price and a snippet of up to 600 chars) and about 60 output.
- About **$0.0016 per call**. Real usage was not checked in PostHog traces.

| Check interval | Calls/month (0.67 to 1.0 of checks) | Cost per product monitor per month |
|---|---|---|
| 24h | 20 to 30 | $0.03 to $0.05 |
| 6h | 80 to 120 | $0.13 to $0.19 |
| 1h | 480 to 720 | $0.77 to $1.15 |
| 15m | 1,930 to 2,880 | $3.10 to $4.60 |
| 5m | 5,800 to 8,640 | $9.30 to $13.80 |

At today's measured mix (median 1 change a day) the cost is about **$0.05 per product monitor per month**. A product group of 4 listings on 1h checks would cost $3 to $5 a month.

### Sites whose fingerprint changes on nearly every check (measured)

80% or more of at least 10 successful checks changed the fingerprint.

Single-product pages:
- costco.com: 2 monitors, 100% (24h)
- jdsports.ca: 80% (24h)
- pokemoncenter.com came close: 64 to 69% (1h)

Multi-item pages, which show what a product group could hit:
- 1h checks: casiostore.bhawar.com (100%), llm-stats.com (100%), bol.com (100%), google.com (100%), amazon.eg (100%), amazon.in (100%), triggertech.com (94%), reverb.com (91%), metacareers.com (86%)
- 6h checks: snipes.com (99%), nettivene.com (100%), milanuncios.com (100%), capitaloneshopping.com (81%)
- 24h checks: wickes.co.uk (90 to 100%), apple.com (100%)

**Why: not found.** Page text is not stored, so the measurement can't show what changed. I fetched jdsports.ca, arcteryx, casiostore and wickes twice, 20 seconds apart, with plain HTTP. The text was the same both times. So the churn is either slower than seconds (review counts, "recently viewed" or recommendation blocks, stock counts) or only shows on the JS-rendered page the scraper reads. On 24h monitors some changes are probably real price or stock moves.

### What this means for ticket 04

- A whole-page fingerprint is a poor trigger for a single product. Most product pages "change" on most checks.
- The quick check already splits the page into entries, each with a title, price and snippet. Hash the product's entry and re-score only when that hash changes. If the churn is outside the product's own text, this cuts most calls at no extra cost. Check this on costco.com and jdsports.ca first, because nobody has confirmed where their churn sits.
- If ticket 04 keeps the whole-page trigger, 5m and 15m product monitors cost $3 to $14 a month each in AI alone.
