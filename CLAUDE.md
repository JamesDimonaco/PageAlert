# PageAlert (repo name prowl)

## Stack and commands

- Turbo monorepo, pnpm 10. `apps/web`: Next.js 16, React 19, Convex (functions in `apps/web/convex`),
  Better Auth, Polar billing. `apps/scraper`: Hono + Playwright 1.63, Anthropic SDK. `packages/shared`:
  shared types and logic, imported as `@prowl/shared`.
- Root: `pnpm dev`, `pnpm dev:web`, `pnpm dev:scraper` (port 3001), `pnpm build`, `pnpm lint`, `pnpm test`.
- Tests are Vitest in every package. `apps/web` runs Convex functions under `convex-test`.
- Convex commands run from `apps/web`. `/pr-test` notes live in `.claude/pr-test.md`.

## Where things live

- Identity lane: personal. J M Dimonaco LTD is the data controller, so legal copy starts from the company.
- Web: Vercel project `prowl-web`. Domain pagealert.io.
- Scraper: Railway workspace "James Dimonaco's Projects", project `kind-wonder`, service `@prowl/scraper`,
  built from `Dockerfile.scraper`. URL `https://prowlscraper-production.up.railway.app`.
- Convex: dev `energetic-mongoose-440` (eu-west-1), prod `artful-starling-377` (us-east-1).
- PostHog: project 354294. Query with `phog personal 354294 "<HogQL>"`.
- Env: `apps/web/.env.local` holds the Convex, scraper, auth, Resend, PostHog and Polar vars.
  `.env.example` lists every name. Anything read inside Convex is set in the Convex dashboard too.
  The scraper reads `apps/scraper/.env` (`SCRAPER_API_KEY`, `ANTHROPIC_API_KEY`, `SCRAPFLY_API_KEY`).
- Deploy = merge to main. No CI. Railway rebuilds the scraper and Vercel runs `build:production`
  (`convex deploy` then `turbo build`). The two land in no fixed order, so a scraper response-shape
  change must work with either side first. `gh api repos/JamesDimonaco/PageAlert/commits/<sha>/status`
  shows both results.
- Prod logs: `npx convex logs --prod --history 400 --success --jsonl`. Read-only data:
  `npx convex run --prod --inline-query '<js>'`. Scraper logs: `railway logs`.

## Kill switches on Convex prod

`INACTIVITY_PAUSE_ENABLED`, `BILLING_RECONCILE_ENABLED` and `SMS_ENABLED` are all `true` on prod.
The code reads as dry-run by default, but prod is live. Never run `inactivity:pauseDormant` or
`tiers.reconcile` on prod to "check" them: they pause monitors, grant tiers and email real users.
Read the last run from the logs instead.

## Gotchas

- When something breaks, check the Railway scraper too, not only Convex and Vercel.
- A green deploy and `/health` 200 do not prove the scraper works. After any scraper deploy or deps bump,
  POST `{"url":"https://books.toscrape.com/","matchConditions":{}}` to `/api/quick-check` with the
  `x-api-key` header. Pass is 200 with `accessible: true`. A 500 in under 100ms means no browser.
- All worktrees share one Convex dev deployment. `npx convex dev --once` replaces the whole schema and
  function set, dropping what other branches added. Read the "Deleted" lines and say so.
- Dev has no live monitors, so a cron there returns "0 of 0". To verify, push a throwaway
  `convex/_tmpVerify.ts` that seeds fixtures, drive it with `npx convex run`, then scrub and delete it.
  `convex run` is unauthenticated, so auth-gated mutations cannot be driven this way.
- Branch worktrees from `origin/main` after `git fetch`. Local main often lags.
- Polar webhooks arrive late, out of order or never. `tiers.reconcile` (daily 07:30 UTC) is the truth.
  Judge billing by Polar's `/v1/subscriptions/` against `userTiers`, never the table against itself.
- Raw URLs are not identity. Amazon re-stamps most links per request. Use `canonicalUrl` from
  `packages/shared/src/url-identity.ts`. When changing it, count old-form keys as seen for one cycle.
- `scrapeLogs.matchCount` is the page's match total per check, not new matches. Never sum it. For
  "alerts fired", count monitors with a recent `lastMatchAt`.
- `proxyBlockCount` never decays: only success, an interval change or an unpark clears it. Judge park
  logic by votes cast on healthy monitors, not by parks. The schema comment "in a row" is wrong.
- Log retention is a read window per tier (`packages/shared/src/retention.ts`), applied in the Convex
  query. Age deletes nothing. Account deletion does.
- `useConvexAuth().isLoading` is not seeded by the layout's `initialToken`. It waits on the WebSocket,
  so switching the dashboard gate to it saves no round trip.
- Run LLM changes against the real API before shipping. A model swap once typechecked but returned
  empty text because a thinking block came first.
- Assert every scripted string replace. A silent no-op once shipped a feature with no button to reach it.
