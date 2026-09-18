# Auto-pause monitors whose owners have gone

**Recommendation:** pause first, then tell them. No "still interested?" question, no pending state, no deadline. A daily cron pauses a monitor when its owner has not been seen for 30 days and has ignored at least one alert from it (or 90 days regardless), sends one email naming the monitor with a one-click restart link that needs no login, and leaves the monitor in the dashboard marked "paused automatically". Paying users are exempt via `isPayingRecord`. On today's data the first run pauses 40 of 65 live monitors across 36 users and removes 136 of 258 scheduled checks a day (53%). The restart link is an opaque random token stored on the monitor row, not a signed URL, which makes the "greenfield token infrastructure" about 80 lines rather than a subsystem.

Status: **built and merged** (PR #79), shipped with the kill switch off. The plan below is
kept as written; what actually shipped differs in the ways listed under "What changed on
contact with the code" at the end, which is the section to trust where the two disagree.

## Why pause-first and not ask-first

| | Ask first (James's version) | Pause first (this plan) |
|---|---|---|
| Emails per dormant monitor | 2 (question, then "we paused it") | 1 |
| New state | `pending` with a deadline, plus the expiry sweep | none, `paused` already exists |
| Outcome for someone who ignores email | paused after X + Y days | paused after X days |
| Outcome for someone who reads email | clicks "yes", stays running | clicks "restart", running again within the hour |
| Cost while waiting for the answer | X + Y days of checks | X days of checks |
| Build | roughly double | one cron, one mutation, one page, one email |

The two designs only differ for people who read email and act on it. The prod snapshot says that group is close to empty: 45 of the 54 owners of a live monitor were last seen within one day of signing up, and 39 of the 52 monitors owned by users gone over 30 days have delivered match emails during the absence (all 97 emails ever sent show `delivered`). These people are not weighing up a question; they are not reading. For them ask-first is the same outcome, later and dearer. For the rare reader, pause-first costs them one click instead of one click, and nothing is lost either way because a paused monitor keeps every setting and its history.

The honest cost of pause-first is a gap in checks between the pause and the click, at most a few hours for anyone who reads the email that morning. The risk section covers who that hurts.

## The rules

All thresholds are constants in `packages/shared/src` next to `MATCH_SCORE_THRESHOLD`, with doc comments giving the reasoning, the house style for `MAX_PROXY_BLOCKS` and friends. None are env-tunable. The one env var is the kill switch (below).

### What "last seen" means

`lastSeenAt(user) = max(newest session.updatedAt, user.createdAt, newest monitor.createdAt for that user)`

- Better Auth bumps `session.updatedAt` when a session older than a day is used (default `updateAge`), and keeps expired rows (117 of 122 in prod are expired, oldest is 178 days old). So the newest `updatedAt` is "last opened the app", accurate to a day. This is what `admin.ts` `fetchLastActiveByUser` already reads; the reaper reuses it (exported, see the cron section).
- **Users with no session row have signed out.** Better Auth deletes the session row on sign-out; it does not prune on expiry. That is why 13 users have none. Only 3 of the 13 own a monitor. For them the fallback is signup time and the newest monitor they created, both of which are real "was here" moments. `monitor.updatedAt` is not usable as a signal: the scheduler bumps it on every check, so it reads "today" on every live monitor.
- `user.updatedAt` is not bumped by login either (it equals `createdAt` for all 13 no-session users), so it adds nothing.

### When a monitor is paused

A monitor is paused by the daily run when it is live (status `active` or `error`, `nextCheckAt` set), not anonymous, its owner is not paying, and either rule fires:

| Rule | Condition | Why |
|---|---|---|
| A. Ignored alert | owner not seen for 30 days, and `lastMatchAt` is after `lastSeenAt` and at least 3 days old | This is the case James described: the monitor did its job, told them, and they never came back. The 3-day grace stops "Match found at 08:00, paused at 10:00" on the same morning, and gives a fresh alert a chance to be acted on. |
| B. Long gone | owner not seen for 90 days | A monitor that has never matched is not yet proven useless, and it is also the embassy-appointment shape, so it gets a quarter rather than a month. After 90 days the owner has outlived 12 session lifetimes and a full grant period. |

Why 30 and not 14: a fortnight's holiday is normal, and false positives land on exactly the engaged users we want to keep. Why 30 and not 60: the last-seen histogram of live-monitor owners is bimodal, 9 seen within 30 days and 45 seen 50 or more days ago, with nobody in between. Any value from 30 to 50 pauses the same people today; 30 stops the leak a month sooner for the next cohort.

Rule B's 90 is the one James might want to cut to 60 (adds 9 monitors and 36 checks a day today). I would not: those 9 are never-matched monitors, which is the highest-regret group.

### Skipped, always

| Skip | Reason |
|---|---|
| `isPayingRecord(tier)` true | James's exemption. Live subscription or a bought Sprint pass. Admin grants do not count, which is why the 41 grant holders in the dormant cohort are not exempt. Today this exempts nobody. |
| `nextCheckAt` undefined (parked) | Costs nothing already. Pausing it would also lose the parked state and, on resume, leave `nextCheckAt` unset, which is the exact shape of the May outage bug. Parked and paused stay separate: parked means the site refuses us, paused means the user stopped caring. |
| `status` already `paused` | Idempotency, and the 2 manual pauses in prod stay manual. |
| `isAnonymous` | Expire on their own via `cleanupExpired`. |
| Banned | Already paused by `banUser`. |

### Projected first run on the prod snapshot

| Rule set | Monitors paused | Users emailed | Checks/day removed |
|---|---|---|---|
| **A=30d, B=90d, grace 3d (chosen)** | **40 of 65** | **36** | **136 of 258 (53%)** |
| A=30d, B=60d | 49 | 42 | 172 (67%) |
| A=14d, B=90d | 41 | 37 | 140 |
| A=30d, B=90d, no grace | 42 | 38 | 141 |
| A=60d, B=90d | 38 | 34 | 128 |

The 60-day-gone cohort James measured (68% of checks) is reachable by dropping B to 60. The chosen set leaves 9 never-matched monitors of users gone 30 to 90 days running, on purpose. The 2 extra runs of 25 checks/day cost about $8 a month at the current $70 to 90 for 269 checks/day, which is the price of not silently stopping a restock watch a month early.

## Signals: last login, not email opens

Agreed with the recommendation already made to James: drop open tracking. Opens would need Resend's tracking enabled (which rewrites links and images), a new webhook event type in `emailEvents.ts`, and would still be blind to Apple Mail Privacy Protection, which prefetches every image and reports every email as opened. Last login is a stronger and cheaper signal. The 201 of 204 unread in-app notifications point the same way, but that flag only flips on click, so it is corroboration, not an input.

One signal does need care: **Telegram and Discord users can act on alerts without ever logging in**. Prod has 3 users with Telegram enabled; 2 of them were last seen 145 and 158 days ago and both have active monitors. They may be reading every alert on their phone. They are not exempt (the checks still cost the same, and they may equally be gone), but the pause notice goes to their Telegram or Discord as well as email, using the same restart link, mirroring what the park path does with `telegram.sendMonitorStoppedAlert` and `discord.sendMonitorStoppedAlert`.

## Schema changes

All on `monitors`, all optional, no backfill for the 67 existing rows or 107 users. Absent means "not auto-paused".

```ts
// Set by the inactivity reaper, cleared by any resume (dashboard toggle or the
// email link). Present means "we paused this, the user has not yet come back".
autoPausedAt: v.optional(v.number()),
// Opaque restart token from the pause email. Only ever resumes a monitor the
// reaper paused, so a manual pause can never be undone by an old email.
resumeToken: v.optional(v.string()),
```

plus `.index("by_resumeToken", ["resumeToken"])`, and add `inactivity-paused` to the `emailSends.kind` comment.

The 2 monitors currently `paused` have no `autoPausedAt`, so the dashboard keeps treating them as manual pauses. The 13 `error` monitors remain eligible; a paused error monitor that is resumed becomes `active` with `retryCount` intact, the same as a manual resume today.

## The restart link

Sized honestly: this is the part James's brief called the largest piece. It is smaller than that because there is nothing to sign.

### Token

| Property | Choice |
|---|---|
| Form | 32 random bytes, base64url, 43 characters. Generated in the reaper action with `crypto.getRandomValues` (actions are unrestricted; mutations are deterministic and should not mint randomness), passed into the pause mutation as an argument. |
| Stored | `monitors.resumeToken`, looked up by index. The lookup is the verification. No secret, no HMAC, nothing to rotate. A tampered link finds no row. |
| Grants | One thing only: resume this monitor. It cannot read results, change settings, or pause. |
| Expiry | 90 days after `autoPausedAt`. After that the page says the link has expired and offers login. 90 days because after a quarter the email is buried and the user should see the dashboard, and so that a token cannot live forever in an inbox. |
| Replay | Harmless: resume is idempotent. The token is cleared on any resume, so a second click after a resume shows "already running or link used", and a monitor the user later pauses by hand cannot be resumed by the old email. |
| Leak surface | The token appears in the page URL, which PostHog's pageview capture would record. The resume page reads `t` and calls `history.replaceState` to strip it before anything else runs. If it leaked anyway, the worst case is somebody restarting your monitor. |

Why not a signed token: a signature would let us skip the row lookup, but we need the row anyway to resume it, and signing adds a secret to provision on prod, a verify function to get subtly wrong, and a rotation story. `emailEvents.ts` shows HMAC is doable in this runtime; it is just not needed.

### Endpoint

`${APP_URL}/resume?t=<token>`, a new public Next page at `app/resume/page.tsx` (outside the `(dashboard)` group, so the auth redirect in `app/(dashboard)/layout.tsx` never fires; `app/try/[id]/page.tsx` is the precedent for a public page keyed by an id). On mount it calls a new **public, unauthenticated** mutation `monitors.resumeByToken({ token })` and renders the result.

Why a page calling a mutation, not a Convex `httpAction` on GET: mail security scanners and link prefetchers fetch links in emails. A GET that resumes would resume monitors nobody clicked, and then the reaper would pause them again in 30 days, sending a fresh email, forever. A page that resumes from JavaScript is immune to that, and still one click for a person. It also keeps the code in the shape the repo already has (a page plus a mutation) rather than the repo's first HTML-rendering HTTP action.

`resumeByToken`:

1. Look up `by_resumeToken`. No row: return `invalid`.
2. `autoPausedAt` older than 90 days: return `expired`.
3. Patch `status: "active"`, `nextCheckAt: now`, `autoPausedAt: undefined`, `resumeToken: undefined`, `updatedAt: now`. Return `{ ok, name, host }`.

What the user sees:

| Result | Page |
|---|---|
| ok | "**Khaki Linen Field Jacket** is running again. We'll check paulsmith.com within the hour." Button: Open dashboard (goes to `/dashboard/monitors/<id>`, which asks for login if needed; the resume already happened). |
| invalid | "This link isn't valid any more. If you want the monitor running, sign in and press Resume." Button: Sign in. Deliberately the same wording for tampered and already-used links; there is nothing useful to say about the difference and no need to confirm a guess. |
| expired | "This link has expired. Sign in to resume the monitor." Button: Sign in. |

Guessing: 256 bits of randomness, no rate limit needed beyond what Convex already applies.

## The cron

New file `convex/inactivity.ts`. In `crons.ts`:

```ts
// Pause monitors whose owners have gone. See inactivity.ts for the rules.
crons.daily("pause-dormant-monitors", { hourUTC: 10 }, internal.inactivity.pauseDormant);
```

10:00 UTC is the hour `onboarding.ts` already chose as globally inoffensive, so any email from us lands at a familiar time. `crons.daily` rather than `interval` so the run time is knowable and does not drift from deploy time. Convex runs at most one instance of a cron at a time.

### Steps in `pauseDormant` (internal action)

1. Read `INACTIVITY_PAUSE_ENABLED`. Anything but `"true"` means **dry run**: do everything below except the mutation and the emails, and log the would-pause list (`userId`, monitor name, rule, checks/day). This is the same pattern as `ONBOARDING_EMAILS_ENABLED` and is how the first prod run gets checked against the numbers in this document before anything is paused.
2. `runQuery(internal.inactivity.listLive)`: every non-anonymous monitor with status `active` or `error` and `nextCheckAt` set, via `by_status` (two queries, `take(500)` each; 65 rows today).
3. `fetchLastActiveByUser` from `admin.ts`, exported. **Add a truncation guard**: it stops after 40 pages of 500 sessions and today returns whatever it has. For the admin table that is cosmetic; for the reaper a truncated map makes unknown users look never-seen and pauses them all. It should return `{ byUser, complete }` and the reaper aborts, with an operator alert, when `complete` is false.
4. Users' `createdAt` from `fetchAllUsers` (already exported in shape; also paged) for the fallback, and the newest `monitor.createdAt` from step 2.
5. `userTiers` for the owners, `isPayingRecord` per owner (export it from `admin.ts`).
6. For each monitor, `dormancyVerdict(...)`, a pure function in `packages/shared/src/dormancy.ts` taking `{ now, lastSeenAt, lastMatchAt, nextCheckAt, status, isAnonymous, isPaying }` and returning `"keep" | "ignored-alert" | "long-gone"`. This is the only part with tests.
7. Group the `pause` verdicts by owner. For each owner, one `runMutation(internal.inactivity.pauseForOwner, { userId, monitors: [{ id, token, rule }] })`.
8. After the loop, one `admin.notify`: "Paused 40 monitors for 36 users (rule A 30, rule B 10). Dry run." or not. One message, not one per user, matching the operator-alert rules in the vault notes.

### `pauseForOwner` (internal mutation)

For each monitor in the argument: re-read the row, and skip it unless status is still `active` or `error`, `nextCheckAt` is set, and `autoPausedAt` is absent. Patch `status: "paused"`, `autoPausedAt: now`, `resumeToken: token`, `updatedAt: now`. Insert one in-app notification per monitor via the same shape `userNotifications.create` uses ("Paused: Khaki Linen Field Jacket").

Then, if at least one monitor was actually paused in this transaction, `ctx.scheduler.runAfter(0, internal.emails.sendInactivityPaused, { to, userId, monitors: [...] })` and the Telegram or Discord equivalents when those channels are enabled for the user. Convex commits the scheduled call atomically with the patch: either the monitor is paused and its email is queued, or neither happened.

### Idempotency and failure

| Case | What happens |
|---|---|
| Runs twice in a day | Second run sees `paused` and skips. No second email. |
| Crashes halfway | Every owner already processed has their monitors paused and their email queued (atomic). Owners not reached are picked up tomorrow. Nothing is half-done for one owner because an owner is one transaction. |
| Email send fails | `send()` records a `failed` row in `emailSends`, as every email does today. The monitor stays paused. The daily bounce alert already covers bounces and complaints. Since a failed send means a paused monitor with no notice, the admin dashboard's failed-send list is the thing to glance at after the first real run. |
| Check in flight when the pause lands | `recordCheckResult` drops results for anything not `active` or `error`, so the in-flight check's result is discarded and it is not rescheduled. |
| User resumes during the run | They are by definition not dormant, so they are not in the list. |
| Session scan truncated | Abort, alert, pause nothing. |

### Scale

Fine at 107 users. At 10,000 users, roughly 6,000 monitors and 50,000 session rows:

| Breaks | Decision that changes |
|---|---|
| `fetchLastActiveByUser` walks every session row daily and caps at 20,000 | Look up sessions per owner instead, using the session table's `userId` index through `components.betterAuth.adapter.findMany` with a `where`, which `deleteAllRowsByUser` already does. Work then scales with live-monitor owners, not with signups. Or record `lastSeenAt` ourselves from a Better Auth session hook. Either is a contained change to step 3. |
| `listLive` with `take(500)` misses rows | Page it, or move the verdict into a paginated query. |
| Pausing 3,000 monitors on the first enabled run sends 3,000 emails at 10:00 | Stage the first run by owner `createdAt`, or by rule B first. At 107 users the first run is 36 emails and needs no staging. |
| One action doing all of it hits the action time limit | Split into per-owner scheduled mutations. |

None of these change the rules or the token.

## Email

From `alerts@pagealert.io` (`FROM_EMAIL`): this is transactional, about a monitor the user set up, not marketing from `hello@`. New action `emails.sendInactivityPaused` in `convex/emails.ts`, `kind: "inactivity-paused"`, styled like `sendMonitorStoppedAlert` (same card, same footer, amber header), one email per user per run listing every monitor paused that run with its own restart button. Most dormant users have one monitor (40 of 45); 5 have two or three.

Subject: `We paused Khaki Linen Field Jacket` (one) or `We paused 2 of your monitors` (several).

Body, single monitor:

> **Paused: Khaki Linen Field Jacket**
>
> You haven't been back to PageAlert since 12 June, so we've stopped checking paulsmith.com for you. Nothing is deleted. Press the button and it picks up where it left off, no need to sign in.
>
> [Restart this monitor]
>
> If you're done with it, there's nothing to do.

Plain-text version with the same words and the bare link. The date is DMY. When the monitor has alerted since they were last seen, add one line above the button: "We sent 4 alerts for it in that time." (count of in-app `notifications` for that monitor since `lastSeenAt`, via `by_monitorId`; a few rows). Omit the line for rule-B monitors that never matched. This is the one place the email says why, and it is true.

Telegram and Discord: one short message per monitor with the same restart link ("PageAlert paused Khaki Linen Field Jacket because you haven't been back since 12 June. Restart: <link>"), sent only where `notificationSettings` has the channel enabled for the user, exactly the branch the park path takes.

### How this sits with the match and error emails

- A paused monitor sends nothing else. The scheduler never reads `paused`.
- The 3-day grace in rule A means a monitor that alerted this morning is not paused this morning.
- One run a day and one email per owner per run, so a dormant user gets at most one pause email a day and, in practice, one ever: a resumed monitor gets a fresh 30 days from the resume (the resume is a session, so `lastSeenAt` moves).
- Onboarding day0 goes to new users; dormant users are by definition past 30 days. No overlap.

## What the user sees in the dashboard

- `StatusBadge` shows "Paused" as it does today.
- Detail page (`monitors/[id]/page.tsx`) and `MonitorCard` show one line under the header when `autoPausedAt` is set: "Paused automatically on 17/09/2026 because you hadn't been back for a while. Resume to start checking again." The existing Resume item in the menu is the undo.
- `monitors.update`: when `status` changes to `active` and `autoPausedAt` is set, clear `autoPausedAt` and `resumeToken` and set `nextCheckAt: now`. Setting `nextCheckAt` on resume also closes a latent gap: today a resume keeps the old `nextCheckAt`, and a monitor parked then paused by `banUser` would resume with no `nextCheckAt` and never run again.
- The dashboard's status filter already has "Paused".
- The `/resume` page after a successful click links to the monitor's detail page.

PostHog: one event on the resume page (`monitor_auto_pause_resumed`, with the rule) alongside the existing `trackMonitorResumed`. It is the only number that says whether the email works.

## The 6 October grant cliff

55 users drop from Pro to free on 06/10/2026 via `expireGrants`. Facts that bound the interaction:

- `expireGrants` only slows monitors on 5m, 15m or 30m to 1h (`FREE_INTERVALS` is 1h/6h/24h). Every one of the 52 dormant-cohort monitors is on 6h or 24h. **The cliff changes nothing about what the dormant cohort costs or does.** The saving has to come from this feature.
- Admin grants are not `isPayingRecord`, so the reaper treats grant holders as free already. Extending or ending the grants does not change who gets paused.

Recommended order: ship this first and enable it before the cliff. It is independent of the cliff, and for the 36 users it touches the cliff is invisible (they will not see a tier badge change). The one real risk of overlap is **two emails to the same person inside a fortnight** if James decides to send a "your Pro trial is ending" email: a pause notice on day 1 and a trial-ending notice on day 12. If a cliff email goes out, exclude users all of whose monitors are paused, since they have nothing to lose by the downgrade. James is deciding the cliff separately; this plan does not depend on that decision.

## Tests

| Test | Harm it prevents |
|---|---|
| `dormancyVerdict` unit tests in `packages/shared/src/dormancy.test.ts` (vitest already runs there): boundaries at 30 and 90 days, the 3-day alert grace, lastMatch before vs after lastSeen, paying skip, parked skip (`nextCheckAt` undefined), anonymous skip, already paused, no-session fallback to signup and monitor creation | The reaper silently pausing an engaged user's or a paying user's monitor, or pausing a parked one. Every rule is an off-by-one away from stopping someone's embassy watch, and nothing else in the pipeline would notice. |
| `resumeByToken` outcomes (ok, invalid, expired, cleared token) | The restart link not working is "the monitor is lost" for someone who cannot remember which Google account they used. But there is no Convex test harness in the repo (`convex-test` is not installed, `apps/web` has no test script). Adding one for three cases is not proportionate. Verify by hand on the dev deployment with the checklist below, once, before enabling on prod. |

No tests for the email HTML, the cron registration, or the dashboard note. The dry run is the acceptance test for the reaper: on prod, with the switch off, the log should name 40 monitors and 36 users, matching this document before anything is paused.

Manual checklist on dev before enabling on prod:

1. `npx convex run inactivity:pauseDormant` with the switch off; read the dry-run list.
2. Set the switch on dev, run again; one test account's monitor goes to `paused` with `autoPausedAt` and `resumeToken`, one email arrives, and the dashboard shows the note.
3. Click the email link in a logged-out browser: the monitor is `active`, `nextCheckAt` is now, both fields are cleared, the page shows the name and host.
4. Click it again: "isn't valid any more".
5. Pause the monitor by hand, then open the link again: still paused (the token was cleared, and the mutation never resumes a manual pause).
6. Run the reaper again: nothing new is paused, no second email.

## What could go wrong, ranked

| # | Risk | Worst case | Mitigation in this plan |
|---|---|---|---|
| 1 | **Silently stopping a monitor someone is relying on**: a US embassy appointment or a restock, where silence is expected and the owner has no reason to log in | The slot opens the week after we paused it and nobody is told | Rule A never fires on a monitor that has not alerted; never-matched monitors get 90 days. The pause is announced by email and on Telegram or Discord where connected, the restart needs no login, the monitor stays in the dashboard with the reason, nothing is deleted. Not eliminated: a user gone 90 days who reads none of it. That is the price of the 53%, and it is the same person the ask-first design would also have paused. |
| 2 | Pause email lands in spam | Same as 1, for everyone | Sent from `alerts@`, which has delivered 97 of 97 so far. Bounces and complaints already alert the operator. |
| 3 | Reaper rule bug pauses engaged users | Angry users, trust gone | Pure verdict function with tests; dry run on prod first; first real run is watched. |
| 4 | Truncated session scan makes users look never-seen | Everyone paused in one morning | Abort-and-alert guard on `fetchLastActiveByUser`. |
| 5 | A resumed monitor is paused again 30 days later because the resume did not register as "seen" | Loop of pause emails | The resume page is a session, and `resumeByToken` clears `autoPausedAt`. If James wants belt and braces, the mutation can also stamp `lastResumedAt` and the verdict treat it as a seen event; not planned unless the loop is observed. |
| 6 | Link prefetch by mail scanners resumes monitors nobody clicked | Saving quietly leaks back | Resume happens from page JavaScript, not on GET. |
| 7 | First enabled run sends 36 emails in one minute | A couple of complaints | Small enough not to stage. Watch the bounce alert. |
| 8 | Telegram-only users who read alerts on their phone and never log in | Paused although engaged | They get the notice on Telegram with the same one-click link. Two users today. |
| 9 | Token in the URL captured by PostHog | Someone could restart a monitor | Stripped from the URL before capture; a restart is the only thing the token can do. |
| 10 | Collision with `fix/proxy-block-park` | Reaper pauses a parked monitor, which then resumes with no `nextCheckAt` | Reaper skips `nextCheckAt: undefined`; both resume paths set `nextCheckAt: now`. That branch changes how a block is detected, not what parked means, so nothing here depends on it. |

## Build order and size

One PR, reviewed with `/code-review high` before merge (it pauses three quarters of production). The working tree is currently on `fix/proxy-block-park`; branch this from `origin/main` after that lands.

| Piece | Files | Size |
|---|---|---|
| Verdict function and tests | `packages/shared/src/dormancy.ts`, `dormancy.test.ts` | ~60 + ~80 lines |
| Schema | `convex/schema.ts` | 4 lines and an index |
| Reaper | `convex/inactivity.ts`, `convex/crons.ts`, exports and the truncation guard in `convex/admin.ts` | ~150 lines |
| Resume | `convex/monitors.ts` (`resumeByToken`, and clearing in `update`), `app/resume/page.tsx` | ~40 + ~80 lines |
| Email, Telegram, Discord | `convex/emails.ts`, `convex/telegram.ts`, `convex/discord.ts` | ~120 lines, mostly the HTML card |
| Dashboard note | `monitors/[id]/page.tsx`, `monitor-card.tsx` | ~20 lines |
| Env | `INACTIVITY_PAUSE_ENABLED` on Convex prod, documented in `.env.example` | 1 line |

Rollout: merge with the switch off, read the prod dry-run log the next morning, send James the email from dev, then set the switch on prod. Expect the first real run to pause 40 monitors for 36 users.

## Corrections to the brief

Things checked against the snapshot or the code that differ from what was assumed:

- **"No session row" means signed out, not never logged in.** Better Auth deletes the row on sign-out. 3 of the 13 own a monitor, and all 3 created it within the last 83 days; one signed up and built it 5 days ago. Signup time and monitor creation are the right fallback, and the 30-day rule protects the new one.
- **The token piece is not the largest piece.** An opaque token stored on the row needs no signing, secret, or verification code. The email card and the reaper are each bigger.
- **Prod has zero parked monitors today** (no `error` row with `nextCheckAt` unset). `fix/proxy-block-park` is what will make parks happen; the reaper skips them either way.
- **The cliff does not touch the dormant cohort's cost.** `expireGrants` only slows 5m to 30m intervals; the cohort is all 6h and 24h.
- **The cohort never came back at all**: 45 of 54 live-monitor owners were last seen within a day of signup. This is not slow drift, which is the main reason ask-first would not change outcomes.
- My count of the 60-day cohort from the snapshot is 40 users, 47 monitors, 164 of 258 checks/day, against the brief's 42, 49 and 183 of 269. Same picture; the difference is the fallback I use for no-session users and how error-lane monitors are costed.
- `convex/_generated/ai/guidelines.md`, which `CLAUDE.md` says to read first, does not exist in the repo (`npx convex ai-files install` has not been run). Already noted in the vault's open items.

## What changed on contact with the code

Written after building it. Where this contradicts the plan above, this is right.

- **The restart click is not a session.** Risk #5 dismissed the pause loop on the grounds that
  "the resume page is a session, so `lastSeenAt` moves". It is not — the link signs nobody in,
  so the next day's run would pause the monitor again, one email a day forever. `resumeByToken`
  stamps `monitors.lastResumedAt` and the reaper counts it as a last-seen moment.
- **The session table cannot answer "when were you last here".** Better Auth deletes a session
  row on sign-out *and* deletes an expired one the next time any page loads, so a user who signs
  out, or who returns after their cookie lapsed and bounces off the login page, reads as
  never-seen-since-signup. Rule A would pause their monitor days after they were reading the
  alert. There is now a `userActivity` table the app owns, stamped by the dashboard and throttled
  to an hour; the fallback chain is a tested pure function, `lastSeenFrom`.
- **`lastMatchAt` does not mean "we alerted you".** It is stamped on every new match, including on
  muted monitors and ones with every channel switched off, where the notification branch is
  skipped entirely. Rule A fired on those — 30 days instead of 90, on an alert nobody received.
  The verdict takes `alertsSuppressed`.
- **The token is 64 hex characters in the URL fragment**, not 43 base64url in a query parameter.
  Hex needs no encoder the runtime may not carry; the fragment is never sent to the server, so
  the token stays out of request logs and out of the pageview URL PostHog builds from the query
  string at render — the plan's "strip it with replaceState" was always too late.
- **The email names the match date** ("It found something on 14 August, after you were last
  here") rather than counting notifications. Error and park notices share the notifications
  table, so a count promised alerts we never sent.
- **The pause notice ignores `muted` and the monitor's channel list**, unlike the park path it
  otherwise mirrors. Mute means "stop telling me what you found"; this is "we stopped looking".
- **`pauseForOwner` re-reads the owner's tier and activity** inside its transaction, not just the
  monitor's state: the verdicts are computed in an action beforehand, and someone who opens the
  dashboard or buys a plan in between has to win.
- `listLive` takes 1000 per status, not 500. The cron carries `minuteUTC`. `resumeByToken` refuses
  a banned owner, which `banUser` does not cover for an already-paused monitor. The PostHog event
  carries the outcome, not the rule.
- Verified against the dev deployment rather than reasoned about: the six-step checklist above,
  plus muted-escapes-rule-A, the activity stamp, and the ban refusal.
