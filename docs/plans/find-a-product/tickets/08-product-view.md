# 08: Product view

**What to build:** Each product has its own page. It lists every listing with its state, price, stock and last check. From here the user edits the product's alert criteria, channels and check interval, and the changes apply to every child monitor. They can also pause all, delete the product, stop watching one listing, or start watching a suggested one.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] The page shows the product name and region, then each listing: site, title, latest price, stock status, last checked, and state.
- [ ] Clicking a watched listing opens its normal monitor page.
- [ ] Editing criteria, channels or interval saves on the product and rewrites every child monitor, including its prompt. `product_criteria_updated` fires.
- [ ] "Start watching" on a suggested listing creates its monitor, following the same slot rules as ticket 07.
- [ ] "Stop watching" deletes that listing's monitor and sets the listing back to `suggested`.
- [ ] "Dismiss" hides a suggested listing, and it can be shown again.
- [ ] "Pause all" and "Resume all" act on every child monitor.
- [ ] "Delete product" asks for confirmation, then deletes the product and all its monitors.
- [ ] Only the owner can see or change the product.
