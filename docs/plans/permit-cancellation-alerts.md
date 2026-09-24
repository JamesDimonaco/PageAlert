# Permit and hut cancellation alerts

**Recommendation:** spend a day finding out which permit sites PageAlert can already read, before building anything. Start with NZ DOC Great Walks (James's next trip, and the least verified site), then recreation.gov, hut-reservation.org and the TMB refuges. Decide the product shape from what works. If NZ DOC works, James dogfoods it on his own trip first.

Status: **research**, decision pending. James wants the research before choosing between dogfooding and building for a new audience.

## The idea

Huts, campsites and trail permits sell out, then people cancel and the space reappears. That's the "someone cancelled, grab it" problem that appointment portals have (PROWL-036 in the vault), but on sites that are mostly public, with no login needed to view availability. It also fits how James travels.

## Sites

"Verified" means checked directly on 2026-09-24 with one request. "Secondhand" means other tools or articles rely on it and we didn't test it ourselves.

| Site | Viewable without login | Machine-readable | Bot defence | Competitors | Verdict |
|---|---|---|---|---|---|
| **recreation.gov** (US campsites, permits) | Yes | **Verified:** `/api/camps/availability/campground/<id>/month?start_date=…` returned 200 JSON with per-site, per-day status. Also the official RIDB API, free with a key | Their FAQ says they see no large-scale bot abuse | Campnab ($10-29/mo), Campflare (free), Arvie ($19.95/mo, auto-books) | Proven demand, crowded |
| **NZ DOC Great Walks** (bookings.doc.govt.nz) | Yes, live calendar | No JSON found. **Verified** that it's a JS app (`#!greatwalk-result`), so it needs Playwright | Page loads reCAPTCHA and a `btchecker.js` script; virtual queue on launch days | None found | Unknown: the spike decides |
| **hut-reservation.org** (Swiss/Alpine huts) | Yes | Secondhand: a public availability endpoint (an MCP server wraps it) | Unchecked | None found | Promising niche |
| **TMB refuges** (montourdumontblanc.com) | Yes, availability page | Unchecked | Unchecked | TMB Alerts (tmb-alerts.com) | Real demand, owned |
| **Alhambra** | Yes; last-minute tickets released nightly | Unchecked | Unchecked | None found | Maybe; check ToS |
| **Torres del Paine** refugios | Partly | Unchecked | Unchecked | TorresHike claims 24/7 watching | Owned |
| **Inca Trail** | **No.** Only licensed operators see availability; permits are non-transferable | No | n/a | n/a | Drop |
| **Ghibli Museum** | Yes, monthly release | No | IP-blocks aggressive refreshing; needs a Japanese phone number to book | n/a | Drop |

Sources: campnab.com, happiestoutdoors.ca/camping-cancellation-apps, recreation.gov/faq, doc.govt.nz online bookings, tmb-alerts.com, tierrasvivas.com (Inca Trail), japantravel.com (Ghibli). Most ToS automation clauses were not found in this pass.

## Where PageAlert fits

On recreation.gov, the incumbents have hardcoded integrations covering thousands of campgrounds, and one is free. Competing there means building a recreation.gov integration: a second product, not a PageAlert feature.

PageAlert's generic scraper suits the long tail instead: hut systems, small booking sites and one-off permits that no dedicated tool covers. The pitch would be "any booking page, in plain English", backed by templates for the sites we've proven work.

Check speed matters. Free is 1h and the fastest tier (Max) is 5m. We don't know how long a cancelled NZ hut bunk stays open; if it's minutes, a 1h check is useless and this is a paid-tier feature.

## Legal

Alert-only, no auto-booking, the same line as PROWL-036. The US BOTS Act covers event tickets resold across state lines, not campsites or permits (congress.gov S.3183). No law was found against availability monitoring. Read each site's ToS before shipping a template for it.

## Spike (one day)

1. Create real PageAlert monitors on prod (James's account) for one Great Walk, one recreation.gov campground page (the page, not the JSON), one hut-reservation.org hut, the TMB availability page and Alhambra. Run each on the fastest interval available for a few days.
2. Record for each: first scan readable? Items extracted correctly (dates and spaces)? Blocked later? Scrapfly needed?
3. If NZ DOC works, James keeps his monitor for the trip and notes whether an alert ever arrived in time to book.
4. Write the results into this doc and pick one:
   - **Templates only:** a "permits" section in the template gallery for the sites that work. Cheap.
   - **Landing page and SEO** for permit hunters, if two or more niche sites work reliably.
   - **Drop it**, if the sites people want are the ones we can't read.

## Open questions for James

- Which Great Walk, and which dates? That sets the real test.
- Would you pay for faster checks on a trip-critical monitor? That tests whether this is a paid-tier feature.
- Is a recreation.gov integration ever on the table, or is it firmly "stay generic"?
