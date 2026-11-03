# 04: Back-in-stock alerts on single-product monitors

**What to build:** A user with a monitor on a single product page can switch on "Tell me when it's back in stock". When the product goes from out of stock to in stock, they get an alert on their chosen channels. Today this doesn't work at all: a product page is scored once, marked as seen, and never judged again.

This ticket brings in the new alert model. Ticket 05 adds price options to it.

```ts
alertOn: { backInStock?: boolean; priceDrop?: boolean; priceBelow?: number /* minor units */ }
lastSeen: { inStock?: boolean; price?: number /* minor units */; currency?: string }
```

A monitor with no `alertOn` behaves exactly as today.

**Blocked by:** 01 (cost check), 02 (old system removed)

**Status:** ready-for-agent

- [ ] A monitor is recognised as single-product when its first scan finds one product. The monitor page then shows the stock alert option. Other monitors don't show it.
- [ ] On every check where the page changed, a single-product monitor re-scores its one product, skipping the "seen before" shortcut. The scoring call returns `inStock` and the price.
- [ ] Prices are converted to integer minor units with a currency code at the point we read them. No floats are stored.
- [ ] `lastSeen` is updated on each such check.
- [ ] The alert fires only when `inStock` goes from false to true. A product that stays in stock never re-alerts.
- [ ] The alert goes out on the user's channels (email, Telegram, Discord, SMS if opted in, in-app, push), naming the product and site, with a link.
- [ ] Muted monitors don't send it, the same as match alerts.
- [ ] `alert_sent` fires with type `stock`. Match alerts also fire `alert_sent` with type `match`.
- [ ] Tests cover the false-to-true rule: in stock to in stock is silent, out to in alerts, and an unknown stock value never alerts.
