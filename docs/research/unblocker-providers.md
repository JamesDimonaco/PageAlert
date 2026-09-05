# Blocked-site fallback: ScrapingBee vs Scrapfly vs Zyte API

**Recommendation:** Scrapfly's Discovery plan ($30/mo) is the safest fit, it has an explicit hard-spend toggle (disable "Allow PAG"), a `cost=true` dry-run to preview credit cost before spending, and its 200,000-credit allowance covers ~6,666 JS+residential-proxy requests/month, comfortably above the 7,000/month ceiling for a low-volume fallback; ScrapingBee is cheaper ($19/mo) but its credit ceiling caps you at ~1,000–3,000 anti-bot+JS requests/month; Zyte is likely cheapest per successful request (pay only for what's used, no wasted plan minimum) but its documented default spending floor is $100, above the £30 cap, and needs a manually-configured custom limit, unverified from primary docs this session, before it can be trusted as a hard stop.

## Comparison table

| | ScrapingBee | Scrapfly | Zyte API |
|---|---|---|---|
| Free trial | 1,000 credits, no card ([pricing](https://www.scrapingbee.com/pricing/)) | 1,000 credits, no card ([pricing](https://scrapfly.io/pricing)) | $5 credit, first billing month ([pricing docs](https://docs.zyte.com/zyte-api/pricing.html)) |
| Lowest paid tier | Hobby: $19/mo, 75,000 credits ([pricing](https://www.scrapingbee.com/pricing/)) | Discovery: $30/mo, 200,000 credits ([pricing](https://scrapfly.io/pricing)) | Standard PAYG: $0/mo base, $100 spending limit, pay-per-success ([pricing docs](https://docs.zyte.com/zyte-api/pricing.html)) |
| PAYG / overage | None, no overage billing; must manually upgrade or buy one-time add-on when credits run out ([knowledge base](https://help.scrapingbee.com/en/article/what-will-happen-to-my-unused-credits-11zt09p/)) | Yes from Pro tier up, at $2.00–$3.50 per 10k credits depending on tier; can be disabled per-project ([pricing](https://scrapfly.io/pricing)) | Yes, this is the base model; billed only for successful requests ([zyte.com/zyte-api](https://www.zyte.com/zyte-api/)) |
| Effective $/request, JS + anti-bot/residential | $0.0063 (25 credits @ $19/75,000), stealth proxy variant $0.019 (75 credits) ([credit system docs](https://help.scrapingbee.com/en/article/credit-system-explained-1h2ackp/)) | $0.0045 (30 credits @ $30/200,000) ([billing docs](https://scrapfly.io/docs/scrape-api/billing)) | Unverified exact figure, third-party-relayed range of $0.0010–$0.016/request for browser rendering before residential proxy surcharge ([pricing docs](https://docs.zyte.com/zyte-api/pricing.html), page itself could not be fully rendered this session) |
| Hard spend cap (not just alert) | Effectively yes, no auto-overage exists to breach the plan price ([knowledge base](https://help.scrapingbee.com/en/category/billing-and-account-ee56lp/)) | Yes, disable "Allow PAG" per project to stop hard at plan credits ([FAQ](https://scrapfly.io/docs/scrape-api/faq)) | Yes, in principle, "spending limit" suspends all API use for the rest of the billing month once hit ([pricing docs](https://docs.zyte.com/zyte-api/pricing.html)); default floor is $100, custom lower limits "below your plan spending limit" are described but not confirmed in detail ([spending controls blog](https://www.zyte.com/blog/new-spending-controls-and-usage-insights-for-zyte-api/)) |

## ScrapingBee

**Pricing.** Free trial: 1,000 credits, no card required. Tiers: Hobby $19/mo (75,000 credits), Freelance $49/mo (250,000), Startup $99/mo (1,000,000), Business $249/mo (3,000,000), Business+ $599/mo (8,000,000). ([pricing](https://www.scrapingbee.com/pricing/))

No pay-as-you-go/overage billing model exists; when a plan's credits run out mid-cycle you must upgrade or buy a one-time add-on pack, or wait for renewal. Unused credits do not roll over. ([billing & account KB](https://help.scrapingbee.com/en/category/billing-and-account-ee56lp/), [unused credits article](https://help.scrapingbee.com/en/article/what-will-happen-to-my-unused-credits-11zt09p/))

**Credit cost (multipliers).** 1 credit: plain request. 5 credits: `render_js` on. 10 credits: `premium_proxy` on, no JS. 25 credits: `premium_proxy` + `render_js`. 75 credits: `stealth_proxy` (JS required). ([credit system explained](https://help.scrapingbee.com/en/article/credit-system-explained-1h2ackp/))

At Hobby ($19/75,000 credits = $0.0002533/credit): JS+premium proxy = **$0.0063/request**; stealth proxy = **$0.019/request**. That plan tops out at 3,000 JS+premium requests/month, or 1,000 stealth-proxy requests/month, before you'd need to manually intervene.

**Hard cap.** No explicit dashboard toggle, but because there is no auto-overage, spend cannot exceed the plan price without a manual account action (upgrade/add-on purchase), functionally a hard cap. ([KB](https://help.scrapingbee.com/en/category/billing-and-account-ee56lp/))

**API request.**
```
GET https://app.scrapingbee.com/api/v1?url=YOUR-URL
Authorization: Bearer YOUR-API-KEY
```
```bash
curl "https://app.scrapingbee.com/api/v1?url=YOUR-URL" \
     -H "Authorization: Bearer YOUR-API-KEY"
```
Params: `render_js=true` (JS rendering), `premium_proxy=true` (residential/premium pool), `stealth_proxy=true` (hardened stealth pool), `country_code=de` (ISO 3166-1 geolocation), `mode=auto` + `max_cost=N` (auto-mode credit ceiling per request). ([documentation](https://www.scrapingbee.com/documentation/))

**Named-site support.** Dedicated Amazon API explicitly documents a `domain` parameter with `co.uk` (United Kingdom) and `nl` (Netherlands) among supported values, i.e. amazon.co.uk and amazon.nl are explicitly documented. ([Amazon API docs](https://www.scrapingbee.com/documentation/amazon/)) No mention found in docs for milanuncios.com, structube.com, paulsmith.com, evisaforms.state.gov, hobbiesville.com, or capitaloneshopping.com.

**Failure detection.** Docs are thin here: target-site response headers are prefixed `Spb-`. In Auto-Mode, if every configuration fails, "the request costs 0 credits", implying a distinguishable failure state, but no documented status code or JSON error field for a manual (non-auto) failed bypass was found. Unverified: exact status code returned on a bypass failure outside Auto-Mode. ([documentation](https://www.scrapingbee.com/documentation/))

## Scrapfly

**Pricing.** Free trial: 1,000 credits, no card required. Lowest paid tier: Discovery $30/mo, 200,000 credits. Pay-as-you-go overflow available from the Pro tier up: $3.50/10k credits (Pro), $2.00/10k (Startup), $1.20/10k (Enterprise). ([pricing](https://scrapfly.io/pricing))

**Credit cost.** Base (datacenter proxy) request: 1 credit. `render_js=true`: +5 credits. Residential proxy pool: 25 credits (replaces the base 1). Worked example in docs: residential + JS render = 25 + 5 = **30 credits**. `asp=true` (anti-scraping protection/CAPTCHA bypass) has no fixed additive cost, it's "free on non-blocked scrape" and may dynamically upgrade the proxy pool (e.g. to residential) if needed, which is what actually drives the cost up. ([billing docs](https://scrapfly.io/docs/scrape-api/billing))

At Discovery ($30/200,000 = $0.00015/credit): JS + residential = **$0.0045/request**. 200,000 credits covers 6,666 such requests/month.

**Hard cap.** From the Pro plan up, PAYG overflow is on by default but can be fully disabled per project ("Allow PAG" toggle) to enforce a true stop at the plan's included credits; a default safety limit also caps PAYG spend at 50% of monthly quota even when enabled. Discovery is the entry tier and note above applies once you'd move to Pro; check whether Discovery itself exposes the same toggle before relying on it, unverified for Discovery specifically. ([FAQ](https://scrapfly.io/docs/scrape-api/faq))

**API request.**
```
GET https://api.scrapfly.io/scrape?url=<url>&key=<KEY>
```
```bash
curl -X GET "https://api.scrapfly.io/scrape?url=https://httpbin.dev/anything&country=us&render_js=true&key=YOUR_KEY"
```
Params: `render_js=true` (JS rendering), `asp=true` (anti-bot bypass), `proxy_pool=public_residential_pool` (residential; default is `public_datacenter_pool`), `country=us` (ISO 3166-1 alpha-2, supports lists/exclusions/weighting). A `cost=true` query flag returns the credit cost of a configuration without executing it, and there's an interactive estimator at scrapfly.io/pricing#estimator. ([API spec](https://scrapfly.io/docs/scrape-api/getting-started))

**Named-site support.** Docs reference a general Amazon scraping tutorial and note Amazon uses CloudFront WAF anti-bot protection that ASP is designed to handle, but no explicit per-TLD (amazon.co.uk/amazon.nl) parameter was found the way ScrapingBee documents one. ([anti-scraping protection docs](https://scrapfly.io/docs/scrape-api/anti-scraping-protection)) No mention found for milanuncios.com, structube.com, paulsmith.com, evisaforms.state.gov, hobbiesville.com, or capitaloneshopping.com.

**Failure detection.** Documented error codes include `ERR::ASP::SHIELD_PROTECTION_FAILED` ("the ASP shield failed to solve the challenge"), `ERR::ASP::UNABLE_TO_SOLVE_CAPTCHA`, `ERR::ASP::TIMEOUT`, and `ERR::ASP::SHIELD_ERROR`. A `result.success` field is also referenced. Exact HTTP status code mapping for these errors was not confirmed (the dedicated error-code reference page returned a 404 this session). ([anti-scraping protection docs](https://scrapfly.io/docs/scrape-api/anti-scraping-protection))

## Zyte API

**Pricing.** Free trial: $5 credit for the first billing month (standard plans); Enterprise trials can get $100–$200 on request. Plans: Standard PAYG ($0/mo commitment, $100 spending limit, 25–52% volume discount, 3,000 RPM), Standard Commitment ($200–$2,500/mo spending limits with a monthly commitment), Enterprise (custom limits, 10,000 RPM). ([pricing docs](https://docs.zyte.com/zyte-api/pricing.html))

Billing is success-based and per-request in dollars, not a credit system, you are charged only for successful requests, at a flat per-request rate for your plan/site tier. ([zyte-api product page](https://www.zyte.com/zyte-api/))

**Effective cost per JS-rendered request.** Not independently confirmed from the live pricing page this session, `zyte.com/pricing` repeatedly failed to render fully via fetch (oversized/JS-driven page). A web search summarizing that same page reported HTTP-only requests at roughly $0.13–$1.27 per 1,000 requests and browser-rendered (`browserHtml`) requests at roughly $1.01–$16.08 per 1,000 requests on standard plans, with residential-IP requests carrying "different base costs" plus network-consumption surcharges. **Mark this as unverified**, re-check zyte.com/pricing directly before budgeting against it. ([pricing docs](https://docs.zyte.com/zyte-api/pricing.html), [pricing page](https://www.zyte.com/pricing/), fetch incomplete)

**Hard cap.** Yes in principle: a "spending limit" set in the dashboard suspends all Zyte API usage for the rest of the billing month once reached, a real stop, not just an alert. Default PAYG limit is $100/mo, above the £30 cap. A blog post states custom limits can be set "below your plan spending limit" and per API key/domain, but the minimum configurable value and exact UI flow were not confirmed. **Verify directly in the Zyte dashboard before relying on it to sit under £30.** ([pricing docs](https://docs.zyte.com/zyte-api/pricing.html), [spending controls announcement](https://www.zyte.com/blog/new-spending-controls-and-usage-insights-for-zyte-api/))

**API request.**
```
POST https://api.zyte.com/v1/extract
Authorization: Basic base64(YOUR_API_KEY:)
Content-Type: application/json
```
```bash
curl \
    --user YOUR_ZYTE_API_KEY: \
    --header 'Content-Type: application/json' \
    --data '{"url": "https://toscrape.com", "browserHtml": true,
    "geolocation": "US", "httpResponseHeaders": true}' \
    https://api.zyte.com/v1/extract
```
Auth is HTTP Basic with the API key as username and an empty password. `browserHtml: true` enables JS rendering (vs `httpResponseBody: true` for plain HTTP); `geolocation: "US"` sets country/proxy location (this also drives use of Zyte's own proxy network, no separate "residential" flag was found, geolocation implicitly selects the right proxy pool). ([migration guide](https://docs.zyte.com/zyte-api/migration/scrapingbee/index.html), [get-started docs](https://docs.zyte.com/zyte-api/get-started.html))

**Named-site support.** No explicit per-domain claims found in Zyte's own docs for amazon.co.uk, amazon.nl, milanuncios.com, structube.com, paulsmith.com, evisaforms.state.gov, hobbiesville.com, or capitaloneshopping.com. (A third-party benchmark reported per-domain Amazon success rates, but per this task's rule that source is excluded, vendor docs make no such per-domain claim.)

**Failure detection.** Zyte API is explicit here: it hides bans and retries automatically where possible, and only returns a response once it succeeds or gives up. When the target site itself returns a non-200 status (e.g. a real 404), that status is passed through in the response's `statusCode` field and you are charged normally. When Zyte cannot avoid a ban in reasonable time, it returns **HTTP 520** and does not charge for that request. ([error handling docs](https://docs.zyte.com/zyte-api/usage/errors.html))

## Gaps / follow-ups before committing spend

- Zyte's exact $/request table for `browserHtml` + `geolocation` (residential) at the lowest tier needs a direct look at zyte.com/pricing (WebFetch could not render the full page this session, likely a JS-driven pricing calculator).
- Whether Scrapfly's Discovery tier (not just Pro+) exposes the "disable Allow PAG" hard-cap toggle needs confirming in the Scrapfly dashboard.
- Zyte's minimum configurable custom spending limit (is £30/$38 settable, below the $100 default?) needs confirming in the Zyte dashboard.
