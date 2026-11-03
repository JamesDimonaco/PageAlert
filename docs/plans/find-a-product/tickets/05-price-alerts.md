# 05: Price alerts: any drop, or below a target

**What to build:** On a single-product monitor, the user can choose "Tell me about any price drop" or "Only tell me when it's below £X". They can combine either with back in stock. Alerts fire only when the price changes, and they show the right currency symbol.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] The monitor page offers the two price options as one choice: off, any drop, or below a target.
- [ ] The target is entered in the product's currency and stored in minor units.
- [ ] "Any drop" fires when the new price is lower than the last seen price.
- [ ] "Below target" fires when the last seen price was above the target and the new one is at or below it. It does not re-fire while the price stays below.
- [ ] A missing or unreadable price never fires an alert.
- [ ] Messages show the old and new price with the currency's symbol. No hard-coded `$`.
- [ ] `alert_sent` fires with type `price`.
- [ ] Tests cover drop, no change, rise, crossing the target, staying below the target, and a missing price.
