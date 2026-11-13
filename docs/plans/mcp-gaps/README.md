# Stock-aware matching and the MCP gaps

Status: built on 13/11/2026 (tickets in `tickets/`); the backfill waits for the deploy. Agreed in a grilling session on 13/11/2026. Terms follow the repo's `GLOSSARY.md`.

## Problem Statement

James used the PageAlert MCP server from another Claude session, as a real user, to watch NZ PC parts. He made 7 monitors named "PC build: …". Six problems came out of it.

1. **False alerts.** Two monitors matched sold-out items on their first scan: a Kingston 16GB DDR5-6000 kit at NZ$199 and a Noctua NH-L9a-AM5 at NZ$89, both "Out of Stock". The prompts asked for "in stock" and "back in stock". Prod confirms each sent an in-app notice and a match email. The web form has the same bug, because both paths save the first scan the same way. Matching checks keywords and price only. The AI reads each item's stock, and matching ignores it.
2. **Restocks are never announced.** A sold-out item that matched is now "already seen". When it comes back in stock, nothing new appears, so no alert fires.
3. **Product pages are not recognised.** Both Computer Lounge pages show the product plus a row of 8 related products. A monitor counts as a product monitor only when its page has exactly one item. So stock and price alerts can never run on these pages, even when switched on.
4. **Agents cannot edit or delete.** The MCP has four tools: preview, create, list and get matches.
5. **Agents give up on blocked shops.** Preview has no proxy attempt and returns plain-text errors. The agent skipped PB Tech and Mighty Ape, though a real monitor would retry them through the proxy.
6. **No structure for many monitors.** Agents cannot search for a product, create a product, or put monitors in a folder. They cannot ask "what matched lately?" without one call per monitor.

## Solution

- Stock becomes part of matching. When the prompt asks for stock, a sold-out item is not a match. When it comes back in stock, it becomes a new match and the user gets a match alert.
- When a page does not show stock, the item can still match, and the user sees "Stock not shown on page". PageAlert is honest about what it did not check.
- A page is a product page when one of its items links to the page itself. That item is the product, and the rest of the page is ignored for stock and price alerts.
- Every live monitor gets one AI re-read so it picks up the new stock rule. This starts only after James's 7 monitors pass the checks in Further Notes.
- The MCP gains tools to update and delete monitors, search for products, create products and folders, and list recent matches across all monitors. Preview gets one proxy attempt. Every tool returns the same error shape.
- Users get folders in the web app as well, so a long list can be grouped under a name like "PC build".

## User Stories

### Stock-aware matching

1. As a user, I want a sold-out item to not count as a match when my prompt asks for stock, so that I never get an alert for something I can't buy.
2. As a user, I want an alert when a sold-out item I asked for comes back in stock, so that I can buy it before it sells out again.
3. As a user whose prompt says "in stock at NZ$220 or less", I want both the stock and the price respected, so that one half of my prompt is never silently dropped.
4. As a user whose prompt does not mention stock, I want matching to behave exactly as before, so that my existing monitors don't change under me.
5. As a user, I want to see "Stock not shown on page" when the page has no stock information, so that I know what PageAlert could not check.
6. As a user, I want a match alert to say when stock was not shown, so that I can decide how much to trust it before I click.
7. As a user looking at the match checks on a monitor, I want a stock row with a pass, a fail or "not shown", so that I can see why an item does or doesn't match.
8. As a user on the web form, I want the same stock-aware first scan as agents get, so that both ways in behave the same.
9. As an agent creating a monitor, I want the first-scan result to leave out sold-out items when the prompt asks for stock, so that I report the right state to my user.
10. As a user, I want "Backorder" and "Pre-order" treated as not in stock, so that I'm not alerted for items I can't get now.

### Product pages

11. As a user watching a shop's product page that also shows related products, I want PageAlert to know which item is the product, so that stock and price alerts work on that page.
12. As a user with price alerts on, I want only the product's price tracked, not the related items', so that a cheap accessory never triggers "price dropped".
13. As a user with a URL monitor on a product page, I want stock and price alerts to use the same code as a Product, so that both behave the same.
14. As a user with a URL monitor on a product page, I want my match alerts kept, so that my monitor doesn't silently change how it alerts.
15. As a user watching a listing page, I want nothing to change, so that listing monitors keep alerting on every new match.

### Backfill

16. As an existing user, I want my monitors to pick up stock-aware matching without me doing anything, so that the fix reaches me too.
17. As an existing user, I want the re-read not to re-announce matches I've already had, so that I don't get a burst of old alerts.
18. As an existing user with a paused monitor, I want it to pick up the new rule when I resume it, so that paused monitors cost nothing meanwhile.
19. As the operator, I want the backfill spread across each monitor's normal schedule, so that it doesn't spike AI or proxy costs in one go.
20. As the operator, I want to compare each monitor's matches before and after the re-read, so that I can review every match that dropped.

### MCP: edit and delete

21. As an agent, I want to rename a monitor, so that my user recognises it in alerts.
22. As an agent, I want to change a monitor's prompt, so that I can fix a prompt that matched the wrong thing.
23. As an agent, I want to change a monitor's check interval, within the user's plan, so that urgent items are checked more often.
24. As an agent, I want to set or clear a monitor's stock and price alerts, so that I can give my user restock and price-drop alerts.
25. As an agent, I want to pause and resume a monitor, so that my user stops getting alerts for something they've bought.
26. As an agent, I want to move a monitor into or out of a folder, so that I can keep my user's list tidy.
27. As an agent, I want a clear error when I try to change a monitor's URL, telling me to delete and recreate it, so that I don't corrupt its history.
28. As an agent, I want to delete a monitor, so that my user's list doesn't fill with things they no longer want.
29. As a user, I want my MCP client to ask me before an agent deletes a monitor, so that nothing is lost by accident.
30. As an agent, I want to update and delete only my user's own monitors, so that one API key can never touch another account.

### MCP: errors and preview

31. As an agent, I want every tool to return errors as `{ code, message, retry }`, so that I can decide what to do without parsing English.
32. As an agent, I want a `blocked` code when a site refuses the read, so that I know a monitor may still work through the proxy.
33. As an agent, I want a `limit_reached` code when the user hits a plan limit, so that I can tell them to upgrade or wait.
34. As an agent, I want `not_found` and `invalid_url` codes, so that I can fix my own input.
35. As an agent previewing a blocked shop, I want one proxy attempt, so that I don't skip shops a real monitor could read.
36. As a user, I want proxy previews capped at 5 a day, so that an agent can't burn the service's proxy credit on my account.
37. As an agent past the daily proxy cap, I want `{ code: "blocked", retry: false }` with the reason, so that I stop retrying and tell my user.

### MCP: products and search

38. As an agent, I want to search for a product by name and region, so that I can find shops selling it without guessing URLs.
39. As a user, I want agent searches to count against my normal daily search limit, so that an agent can't spend more than I could in the app.
40. As a user, I want a failed agent search refunded, the same as in the app, so that broken searches don't use up my day.
41. As an agent, I want to create a Product from shop URLs I picked, so that one item is watched across several shops with one set of alerts.
42. As an agent, I want to set a Product's stock and price alerts when I create it, so that my user gets the alerts they asked for.
43. As an agent, I want to pass stock and price alerts to `create_monitor` as well, so that I don't rely on a guess from the prompt.
44. As an agent who leaves out stock and price alerts, I want the server to guess them from the prompt, so that simple requests still work.

### Folders

45. As a user with many monitors, I want to group them in a named folder like "PC build", so that my dashboard is easier to scan.
46. As a user, I want a folder to hold both monitors and Products, so that one build lives in one place.
47. As a user, I want to rename and delete a folder without deleting what's in it, so that tidying up is safe.
48. As a user, I want folders one level deep, so that organising stays simple.
49. As an agent, I want to create a folder, so that I can group the monitors I make for my user.
50. As an agent, I want to name a folder when I create a monitor or Product, so that it goes straight into the right place.

### MCP: recent matches

51. As an agent, I want all new matches across my user's monitors since a given time in one call, so that I can tell my user what changed without one call per monitor.
52. As an agent, I want each recent match to carry its monitor's id and name and when it matched, so that I can report it clearly.
53. As an agent, I want `get_matches` to keep working as before, so that existing integrations don't break.

## Implementation Decisions

### Stock-aware matching (shared, scraper)

- The extractor returns `inStock: true | false | null` for every item alongside the existing free-text stock field. `null` means the page does not say.
- `MatchConditions` gains an optional `inStockOnly: boolean`. The AI sets it when the prompt asks for the item to be in stock or available. Prompts that don't ask leave it unset.
- `explainMatch` adds a stock check when `inStockOnly` is set: `false` fails, `true` passes, `null` passes and is marked "not shown". `applyMatchConditions` keeps its contract: an item matches when every check passes.
- Backorder and pre-order count as `inStock: false`.
- Old code ignores the new fields, so either deploy order (Railway scraper, Vercel web) is safe.
- Restock alerts need no new code. A sold-out item never enters the seen set, so its return is a new match.
- This is an LLM prompt change. Run it against the real API on James's 7 pages before shipping.

### Honest unknowns (web)

- The match-checks panel shows a stock row with pass, fail or "Stock not shown on page".
- Match alerts on every channel name items whose stock was not shown.

### Product page rule (shared)

- A page is a product page when exactly one item's canonical URL (from `url-identity`) equals the monitor's canonical URL. Otherwise the rule falls back to "exactly one item".
- The product monitor check and the product read both use that item as the product. The other items are ignored for stock and price alerts.
- URL monitors and Products share the product check, the stock read and the alert senders. URL monitors on product pages keep their match alerts. Products keep sending only stock and price alerts.

### Backfill (Convex)

- A one-off internal migration sets the AI re-read stamp to "due" on every active or errored monitor. Each monitor then re-reads at its next normal check, through the scheduled path that compares against the matches it has already seen. That way nothing is re-announced.
- Paused monitors are skipped. They re-read when they resume, because their stamp is already older than the 14-day re-read window.
- Before running it, snapshot each live monitor's current match keys so before and after can be compared.

### MCP tools

- All tools resolve the owner from the API key and check ownership on every monitor, Product and folder they touch, as the existing MCP functions do.
- **Error shape:** every tool failure returns `{ code, message, retry }`. `code` is one of `blocked`, `limit_reached`, `not_found`, `invalid_url`, `failed`. `retry` says whether the same call may work later.
- **`update_monitor(monitorId, { name?, prompt?, checkInterval?, alertOn?, folderId?, paused? })`:** reuses the web app's update logic through a key-owner variant. The URL cannot change. A prompt change behaves as it does in the web app. The interval is clamped to the plan.
- **`delete_monitor(monitorId)`:** reuses the web app's delete logic and is marked `destructiveHint`.
- **`create_monitor`** gains optional `alertOn` and `folderId`. Without `alertOn`, the server keeps today's guess from the prompt. `alertOn` only acts on a product monitor. On any other monitor, the result says so.
- **`preview_page`:** when the direct read is blocked, it makes one proxy attempt. It draws from the fleet-wide fallback budget and from a new per-user daily count capped at 5. Past the cap it returns `blocked` with `retry: false` and the reason.
- **`find_product(query, region)`:** reuses product search, with the same per-plan daily cap, the same reserve and refund, and the same count as the web app.
- **`create_product({ title, urls, alertOn, folderId? })`:** reuses product creation. It takes the URLs the agent picked. It does not search.
- **`create_folder(name)`**, plus `folderId` on create and update.
- **`get_recent_matches(since)`:** finds the user's monitors with `lastMatchAt` at or after `since`, up to 50, then reads their scan history rows that had new matches since then. It returns each item with `monitorId`, `monitorName` and `matchedAt`. It never sums `matchCount`.

### Folders (schema, web)

- A new `folders` table: owner, name, timestamps. One level only.
- Monitors and Products each get an optional folder reference.
- Deleting a folder clears the reference on everything in it and deletes nothing else.
- The dashboard groups by folder. Anything outside a folder shows as today.
- A folder holds no settings: no shared alerts, channels or interval.

## Testing Decisions

- Write each test first and watch it fail on today's code for the right reason. Then make it pass. Break the code once on purpose to prove the test can go red, especially for the stock rule and the proxy cap.
- Test behaviour at the highest seam. Use three seams, all existing:
  1. **Shared pure functions** (`packages/shared`, Vitest): the stock check in `explainMatch` and `applyMatchConditions`, and the product page rule. Prior art: `match.test.ts`, `product.test.ts`. Fixtures are the real Computer Lounge items from prod: the sold-out Kingston kit and the Noctua page with 9 items.
  2. **Convex functions under `convex-test`** (`apps/web/convex`): the MCP tool functions (update, delete, ownership, folder, recent matches, proxy cap, product search cap), the first-scan save, the scheduled check (a restock becomes a new match, and a re-read does not re-announce), and the backfill migration. Prior art: `mcp.test.ts`, `scheduler.test.ts`, `monitorGroups.test.ts`, `productSearch.test.ts`.
  3. **The real extractor against the real API**, run by hand before shipping, on James's 7 pages. The prompt change is checked here, not in a unit test.
- Pin the constants: the 5-a-day preview proxy cap, the 50-monitor cap on recent matches, and the error codes.
- Name the harm in each test, e.g. "a sold-out item never alerts when the prompt asks for stock".
- The MCP route stays thin. Its tests check the error shape and argument mapping only.

## Out of Scope

- **Alerts when a match disappears** ("sale ended", "sold out"). Deferred, not dropped. It is the next feature after this batch.
- Reading "sale ends Sunday" text from pages.
- Turning URL monitors on product pages into Products.
- Nested folders, or shared settings on a folder.
- A webhook channel for agents.
- Widening the prompt regex guess for stock and price alerts.
- Product search inside `create_product`.

## Further Notes

### Build order, one PR each

1. Stock-aware matching, honest unknowns, and the backfill migration (not run yet).
2. Product page rule.
3. `update_monitor`, `delete_monitor`, and the shared error shape.
4. One proxy attempt on preview, 5 per user per day.
5. `find_product` and `create_product`.
6. Folders in the web app and over MCP.
7. `get_recent_matches`.

### Gate before the backfill

After PRs 1 and 2 ship, re-scan James's 7 "PC build:" monitors. Run the backfill on every live monitor only if all of these hold:

1. The sold-out Kingston kit and Noctua cooler no longer match.
2. The other 5 keep their matches, unless the item is out of stock.
3. All 7 show the product's stock and price, including both Computer Lounge pages.
4. The re-scan sent no alerts.

After the backfill, compare each monitor's matches before and after, and read every one that dropped.

After PR 3, give the 7 monitors real stock and price alerts.

### Prod facts, 13/11/2026

- 133 monitors: 63 active, 11 in error, 58 paused, 1 scanning. 25 live monitors have a prompt that mentions stock, across 11 users.
- The two false alerts: monitors `j57fw3t5n0t5zagz8e7vxy0q498j2t41` and `j570ejts3603dbnc4xbek9mqdd8j2cs8`. Each sent one in-app notice and one delivered match email on 12/11/2026.
- The kill switches in the repo CLAUDE.md still apply. The backfill is an internal migration, not `inactivity:pauseDormant` or `tiers.reconcile`.

### Changed while building

- **Restocks did need code.** On a quick check, every judged entry joined the seen set, so a sold-out one was never judged again. Sold-out entries now sit in `soldOutKeys`, from quick checks and AI reads. One is judged again only when its own text changes, up to 5 a check. A read that does not say "in stock" leaves it sold out.
- **The scorer reads stock for several entries.** Its route only took one before. Backorder and pre-order count as not in stock, in both prompts.
- **When scoring fails on a stock-aware monitor,** new entries wait for the next check rather than all alerting.
- **Quick-check alerts join `matchedKeys`,** so a full read does not announce them again. The backfill adds the ones sent before this release.
- **A product page with a stock alert reports its restock only through that alert.** The full read does not also announce the product as a match. With price alerts alone, a price drop can still alert twice; a lost restock would be worse.
- **Preview proxy has its own hourly bucket** of 20, apart from the monitors' escalation budget, after two security reviews pulled in opposite directions.
- **`create_monitor` guesses alertOn from the prompt** when the agent sends none. There was no guess on the MCP before.
- **A prompt change through `update_monitor` makes the next check re-read the page**, and clears the old prompt's seen set. Agents have no rescan tool.
- **`create_folder` returns the existing folder** of the same name, so agents need no list tool to find one.
- **New Zealand is now a search region.** A real search for the Noctua cooler found 4 NZ shops priced in NZD.
- **The AI sets `inStockOnly` on some "any shop offers" prompts.** The real-API run set it on 3 of 4 PriceSpy prompts. It only blocks items read as sold out, so it is safe, but it is not consistent.
