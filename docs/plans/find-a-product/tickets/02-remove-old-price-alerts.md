# 02: Remove the old price-alert system

**What to build:** Delete the old price-alert system. It has never sent an alert: routine checks store no items, so prices are almost never compared. 11 monitors have it switched on, and none has ever fired. After this ticket the app works the same for every user, with less code.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] An internal one-off mutation clears `priceAlerts` from the 11 monitors that hold it. It is deployed and run before the field leaves the schema, because Convex rejects a schema that existing data doesn't match.
- [ ] Remove the price-alert card and its use on the monitor overview.
- [ ] Remove the tracked-item split and threshold badges from the history tab.
- [ ] Remove the `priceAlerts` field, its validator, and the checks in the monitor update mutation.
- [ ] Remove the scheduler's price-alert block and the helpers only it uses.
- [ ] Remove the price-alert senders for email, Telegram, Discord, SMS, in-app and push. Ticket 04 adds new stock and price alerts.
- [ ] Remove `suggestedPriceTrackItems` from the extraction prompt, the shared types and the overview.
- [ ] Remove the unused shared `detectChanges`. Keep anything other code still imports.
- [ ] The `price_tracking_configured` and `price_alerts_updated` events go with the card.
- [ ] Web and scraper typecheck, and existing tests pass.
