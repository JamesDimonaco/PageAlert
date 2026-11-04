# 07: Create a product from approved listings

**What to build:** After a search, the user chooses what to be alerted about: back in stock, any price drop, or below a target price. Then they tick the listings they want to watch and confirm. We create a **product**: one monitor per ticked listing, all set up with the same criteria, channels and check interval. The server first-scans them, so the user can leave the page. Listings they didn't tick are kept in the product as suggestions.

```ts
monitorGroups: {
  userId, name, region,
  alertOn, notificationChannels, checkInterval,
  listings: Array<{ site, url, title, price?, currency?, inStock?, label,
                    state: "suggested" | "watching" | "dismissed", monitorId? }>,
}
// monitors gain: groupId?
```

**Blocked by:** 05 (alert options), 06 (search)

**Status:** ready-for-agent

- [ ] Add the `monitorGroups` table, with `groupId` on monitors. Indexes cover a user's products and a product's monitors.
- [ ] The criteria step offers back in stock, any price drop, and below a target. Defaults suit the product, such as back in stock when a result is out of stock.
- [ ] Channels and interval default to the user's usual choices. The interval defaults to the fastest the plan allows (hourly on free).
- [ ] Each confirmed tick becomes a monitor with `alertOn`, channels and interval copied from the product. The AI writes its prompt from the criteria.
- [ ] New monitors are first-scanned on the server, not in the browser. The UI shows each one's progress.
- [ ] Unticked listings are saved as `suggested`. Accessories the user never revealed are not saved.
- [ ] Ticks are capped at the user's free monitor slots. When full, the UI offers to pause one of their existing monitors to free a slot. The creation rate limit still applies.
- [ ] `product_group_created` fires once per product, with the listing count. `listing_approved` and `listing_dismissed` fire per listing.
- [ ] After creating, the user lands on the product view, or on the dashboard if ticket 08 isn't done yet.
