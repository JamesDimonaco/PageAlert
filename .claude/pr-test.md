# /pr-test notes: PageAlert

## Identity

Personal lane. `ctx`, then `cvx personal`. Convex commands run from `apps/web`.

## Run the PR locally

```sh
git worktree add .claude/worktrees/pr-test-<N> <sha-or-branch>
cd .claude/worktrees/pr-test-<N>
pnpm install --frozen-lockfile
cp /Users/jamesdimonaco/me/PageAlert/apps/web/.env.local apps/web/.env.local
cd apps/web
npx convex dev --once          # pushes the PR's Convex code to dev (energetic-mongoose-440)
npx next dev -H 127.0.0.1 -p 3100   # run in the background
```

- Dev Convex `SITE_URL` is `http://127.0.0.1:3100`. Auth only trusts that origin, so always use
  `127.0.0.1:3100`, never `localhost`. Port 3000 belongs to the Hermes WhatsApp bridge: never kill it.
- Dev is shared scratch. A run leaves it on the PR's code; the next run overwrites it.
- `.env.local` holds only the Convex and scraper vars. PostHog is left out on purpose, so test runs
  stay out of analytics.

## Scraper

- Next's `/api/scraper/*` routes and dev Convex both call the live Railway scraper.
- If the PR touches `apps/scraper`, run it locally (`pnpm dev:scraper`, port 3001) and set
  `SCRAPER_URL=http://127.0.0.1:3001` in the worktree's `.env.local`. It needs an
  `apps/scraper/.env` with `SCRAPER_API_KEY`, `ANTHROPIC_API_KEY` and `SCRAPFLY_API_KEY`. That file
  doesn't exist on this Mac yet: ask James before pulling those keys.
- Convex runs in the cloud, so it can't reach a local scraper. Scheduled checks on dev always use
  Railway. List that under "Not tested" for scraper PRs.

## Log in

- `/login`, email and password.
- Dev: `pagealert-test@dimonaco.co.uk`, Keychain service `pagealert-test-dev`.
- Prod: `pagealert-test+prod@dimonaco.co.uk`, Keychain service `pagealert-test-prod`.

## Hint map

| Code | What it affects | How to test |
|---|---|---|
| `app/(dashboard)/dashboard/**` | Dashboard, monitor detail, logs, settings | Browser |
| `app/try`, `app/page.tsx` | Anonymous try flow, landing page | Browser, logged out |
| `app/api/scraper/*`, `lib/scraper-server.ts` | First scan when creating a monitor | Create a monitor in the browser (counts as a scan) |
| `convex/monitors.ts` | Create, edit, pause, delete monitors | Browser |
| `convex/scheduler.ts` | Scheduled checks, proxy fallback | `npx convex run scheduler:runScheduledChecks` on dev, then read the monitor's logs |
| `convex/pulse.ts` | Daily operator digest | `npx convex run pulse:dailyPulse` on dev. Dev has no `ADMIN_TELEGRAM_CHAT_ID`, so it only logs |
| `convex/emails.ts`, `onboarding.ts` | Emails | Trigger on dev; mail goes only to the test account |
| `convex/sms.ts` | Text alerts | Never send. `SMS_ENABLED` is off on dev. Code review only |
| `convex/betterAuth/**`, `tiers.ts` | Sign-in, billing, Polar | Log in only. No checkout without James |
| `app/(dashboard)/admin` | Admin panel | Skip: the test account isn't admin |
| `packages/shared/**` | Shared types and the changelog | Follow the imports to the pages that use them |

## Reaching code with no screen

- The try form is hidden on the landing page (PROWL-038 5c), and `/try` has no index page (404).
  Call `anonymous:createAnonymous` directly; it needs no auth.
- No screen edits a monitor's URL. Call `monitors:update` as the test user: POST to
  `<NEXT_PUBLIC_CONVEX_URL>/api/mutation` with `Authorization: Bearer <better-auth.convex_jwt>`
  from the cookie jar. The JWT lasts 15 minutes.
- To make a site "known proxy" on dev, replay the scheduler on the test account's own monitor:
  `scheduler:recordCheckResult` with an `error` containing "blocked", then again with
  `usedProxy: true`. Both need `hasNewMatches`, `totalItems`, `matchCount` and `matches`.
- `books.toscrape.com` and `quotes.toscrape.com` are free practice sites, safe for scans.

## Expected noise

- No PostHog requests locally: not an error.

## Never touch

- Real users' monitors, prod data outside the prod test account, Polar checkout, texts.

## Prod

- Deploy check: Vercel project `prowl-web` (team `team_0zgJFkR8hgXQXkSzAgkpR06I`) has a READY
  production deployment of the merge commit. Convex deploys inside that build. Scraper changes
  also need Railway; its token has expired, so check `/health` on the scraper URL instead.
- Alert James if it broke:
  `npx convex run --prod admin:notify '{"text":"pr-test: #<N> broke in prod: <one line>"}'`
