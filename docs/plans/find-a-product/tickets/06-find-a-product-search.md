# 06: Find a product: search

**What to build:** A user with the beta on sees a "Find a product" tab next to "Paste a URL" on the new-monitor screen. They type a product name, check the prefilled region, and press search. They get back up to 8 listings of that product from different sites. Each shows the site, title, price, stock status and a link, labelled "same product", "similar" or "accessory". Results can't be approved yet; ticket 07 adds that.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] The tab only shows when the beta toggle is on, and the server refuses searches from users who have it off.
- [ ] The region is guessed from the request's country and the browser language, shown as "Searching UK sites · change", and saved as the user's default.
- [ ] A new scraper endpoint takes a product name and region. It uses Claude's web search tool to find product pages, at most 8 and one per site.
- [ ] Each result returns the site, page URL, title, price (minor units plus currency), stock status, and a label: same product, similar or accessory.
- [ ] Accessories are hidden by default, with a "Show accessories" link.
- [ ] A Convex action calls the endpoint and enforces the daily limit: free 5, Sprint 15, Pro 30, Max 100. Searches that fail or return nothing don't count.
- [ ] Failed or empty searches say so plainly and offer "Paste a URL instead", which switches tabs and keeps what was typed.
- [ ] The UI shows how many searches are left today.
- [ ] `product_search_started` and `product_search_completed` fire, with region, result count and duration.
- [ ] The search's AI call shows in PostHog LLM analytics, attributed to the user.
