# Find a product

Status: planned, behind a beta toggle. Agreed in a grilling session on 03/11/2026.

## The idea

Most people come to PageAlert to watch a product. Today they must find the right page and paste its URL. With this feature, they type a product name instead. We search the web for listings of that product on different sites. The user ticks the listings they want, and each one becomes a normal monitor. The monitors are grouped under one **product**, which they manage from a single view.

Pasting a URL stays exactly as it is. This is a second way in, not a replacement.

## Why

- About 80% of the 187 monitors created since 25/03/2026 were on shop pages (PostHog, project 354294).
- Finding the right URL and writing a prompt are the hardest steps today.
- More monitors per user means more people reach the free limit, which is our upgrade moment.

## Decisions

**Access**
- Signed-in users only.
- Off by default under Settings → Beta features. The server refuses a search when it is off.

**Search**
- The user types a product name. We guess the region and prefill it, and they can change it.
- The scraper searches with Claude's web search tool. That keeps every AI call in the scraper, so PostHog traces them all.
- One search returns up to 8 product pages, one per site.
- The AI labels each result "same product", "similar" or "accessory". Accessories are hidden unless the user asks for them.
- Each result shows the site, title, price, stock status and a link. No images, because Amazon's rules limit storing them.
- Daily searches: free 5, Sprint 15, Pro 30, Max 100.
- A failed or empty search doesn't count toward the limit, and offers "Paste a URL instead".

**Products (groups)**
- A new `monitorGroups` table holds the name, region, alert criteria, channels, interval, and a listings array.
- Each listing is `suggested`, `watching` or `dismissed`.
- Each ticked listing becomes a normal monitor on its product page, first-scanned on the server. Unticked listings stay `suggested`.
- Criteria, channels and interval are set on the product and copied to every child monitor. Editing a child directly works, but the next product edit overwrites it.
- Only watched listings count as monitors. Ticks are capped at the user's free slots, with an offer to pause another monitor to free one.
- When a user is at their limit, a quiet upgrade banner shows. It never blocks them.
- Stopping one listing deletes its monitor and sets the listing back to `suggested`.
- Existing monitors can't be moved into a product. Clone can start a product from one instead.
- In the UI, a group is called a **product**, as in "Sony WH-1000XM5 · watching 4 listings".

**Alerts**
- The old price-alert system has never sent an alert. It is removed: the item picker card, the `priceAlerts` field, the scheduler price block and its senders.
- It is replaced by one field per monitor:

  ```ts
  alertOn: { backInStock?: boolean; priceDrop?: boolean; priceBelow?: number /* minor units */ }
  ```

- A monitor with no `alertOn` keeps today's match alerts.
- The user picks "any price drop" or "only below £X", plus "back in stock" if they want it.
- Alerts fire only when stock or price changes. There is no cooldown and no minimum change %.
- Prices are stored in minor units (pence or cents) with a currency code. Alerts show the right symbol.
- A single-product monitor re-scores its product on every page change and reads `inStock` and the price.
- The new alerts work on product monitors and on any monitor whose first scan finds a single product.
- v1 sends one alert per monitor. The product digest is the first ticket after v1.

**Tracking (PostHog)**
- `product_search_started`, `product_search_completed`
- `listing_approved`, `listing_dismissed`
- `product_group_created`, `product_criteria_updated`
- `find_more_listings_clicked`
- `upgrade_banner_shown`, `upgrade_banner_clicked`
- `alert_sent`, with type: match, stock or price

## Tickets

Two tracks can run in parallel: alerts (1, 2, 4, 5) and search (3, 6). They meet at 7.

| # | Ticket | Blocked by |
|---|---|---|
| 01 | [Measure how often product pages change](tickets/01-measure-product-page-change-rate.md) | — |
| 02 | [Remove the old price-alert system](tickets/02-remove-old-price-alerts.md) | — |
| 03 | [Beta features setting](tickets/03-beta-features-setting.md) | — |
| 04 | [Back-in-stock alerts on single-product monitors](tickets/04-back-in-stock-alerts.md) | 01, 02 |
| 05 | [Price alerts: any drop, or below a target](tickets/05-price-alerts.md) | 04 |
| 06 | [Find a product: search](tickets/06-find-a-product-search.md) | 03 |
| 07 | [Create a product from approved listings](tickets/07-create-product-from-listings.md) | 05, 06 |
| 08 | [Product view](tickets/08-product-view.md) | 07 |
| 09 | [Product card on the dashboard](tickets/09-dashboard-product-card.md) | 07 |
| 10 | [Find more listings](tickets/10-find-more-listings.md) | 08 |
| 11 | [Quiet upgrade banner at the limit](tickets/11-upgrade-banner.md) | 07 |
| 12 | [Clone a monitor as a product](tickets/12-clone-as-product.md) | 07 |
| 13 | [Product digest alert](tickets/13-product-digest-alert.md) | 07 |

13 is the first ticket after v1.

## Later, no tickets yet

- **eBay Browse API** as a second search source, once eBay approves access. James is applying to eBay Partner Network.
- **Product labelling model.** Trial TypeSafe's JEV, or an open-source option, for the "same product / similar / accessory" check.
- **Launch.** Update the marketing page, then post on Product Hunt and Reddit once it works well.

## Ruled out

- **Amazon's Creators API.** Amazon's Associates policies ban price tracking and alerts unless Amazon agrees, and access needs 10 qualifying sales in 30 days. Amazon stays on the scraper plus Scrapfly proxy, which already reads it.
- **PostHog feature flags for the rollout.** Search runs in Convex, where a flag check means an extra API call. A user setting is simpler.
