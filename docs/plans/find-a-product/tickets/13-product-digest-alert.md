# 13: Product digest alert

**What to build:** The first ticket after v1. When a product monitor fires a stock or price alert, the message talks about the whole product, not one site. For example: "Sony WH-1000XM5 is back in stock at John Lewis for £279, the cheapest of 4 listings."

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] Stock and price alerts from a product's monitor include the product name, the site, and how it compares with the product's other listings (cheapest, or how far above the cheapest).
- [ ] When several listings in one product alert within a short window, they are combined into one message, not one per site.
- [ ] Every channel uses the same wording, shortened where needed (SMS).
- [ ] Monitors outside a product keep today's single-monitor alert.
- [ ] `alert_sent` records whether the alert was a digest.
