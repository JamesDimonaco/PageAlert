# Legal pages refresh

**Status:** not started
**Created:** 2026-09-22
**Blocks:** `SMS_ENABLED=true` in production (Phase 1 only)

## Why

`apps/web/app/privacy/page.tsx` and `apps/web/app/terms/page.tsx` both say "Last
updated: March 2026". They were written in commit `9965793`, before Telegram,
Discord, web push, anonymous scans, Scrapfly, session recording, the Sprint
pass, admin bulk email, ban, inactivity auto-pause, log retention windows, and
the in-flight SMS work.

Three statements on those pages are no longer true. They are the reason this is
a fix and not a tidy-up.

## The three contradictions

Each one is the policy claiming something the code contradicts. Fix these
first, whatever happens to SMS.

### 1. Analytics are not anonymous

Privacy policy: "We collect **anonymous usage analytics** via PostHog."

`apps/web/hooks/use-auth.ts:15` calls `identifyUser(user.id, { email, name })`
on every sign-in, then `setUserProperties({ email, name, created_at, has_image })`.
`apps/web/app/(dashboard)/dashboard/page.tsx:114` adds monitor counts.
`apps/web/lib/posthog.ts:31` sets `person_profiles: "identified_only"`, so a
person profile keyed to that email exists in PostHog for every signed-in user.

Either the copy changes or the identify call does. Changing the copy is the
honest option — the identification is load-bearing for cohort analysis.

### 2. Session recording is running and is not disclosed

`apps/web/lib/posthog.ts:33` sets `disable_session_recording: true` at init,
then lines 57-60 call `startSessionRecording()` on idle. Recording is on, just
deferred. `maskAllInputs: true` and a `[data-ph-mask]` selector are configured,
so typed values are masked — but page content, navigation and clicks are
captured, and nothing on the privacy page mentions it.

Session replay of identified users needs to be named in the policy. Decide
whether it stays on; if it does, say so and say what is masked.

### 3. The ad-blocker opt-out does not work

Privacy policy, twice: "You can opt out of analytics by using a browser ad
blocker or disabling cookies."

`apps/web/next.config.ts:8-16` reverse-proxies PostHog through `/ingest` on the
app's own origin, which is done precisely so blockers do not stop it.

Offering an opt-out that the app is built to defeat is worse than offering
none. Either add a real opt-out control in Settings (a PostHog `opt_out_capturing()`
toggle) and describe that, or drop the sentence and say plainly that analytics
cannot be turned off. A real toggle is the better answer and is a small change.

## Phase 1 — must land before `SMS_ENABLED=true`

Everything here is SMS-specific. The code fix belongs in the SMS PR
(`worktree-sms-alerts`); the copy can land here or there.

1. **Delete `phoneVerifications` in `deleteAllUserData`**
   (`apps/web/convex/account.ts:36-114`). It is the only table holding a raw
   E.164 number that account deletion misses. The privacy policy's "permanently
   removed" claim is false until this lands.

2. **Sweep abandoned verification rows.** A code that is sent and never entered
   leaves `userId` + raw phone + code in the table indefinitely. Rows die only
   on a successful confirm, a later failed confirm, or `releaseVerification`.
   Nothing in `crons.ts` touches them. Add a cron deleting rows past
   `expiresAt` by some margin.

3. **Privacy policy: phone number and Twilio.** New collection paragraph, new
   processor entry, rewritten retention section. Draft copy in
   [Appendix A](#appendix-a--draft-copy).

4. **Terms: a "Text message alerts" section.** Consent, carrier charges,
   allowance and fallback to email, UK/EU geography, opt-out route, delivery not
   guaranteed, one-number-one-free-account. Draft copy in Appendix A.

5. **Settings card disclosure.** One sentence above "Send me a code" covering
   carrier charges, storage, and the allowance. `smsAllowance` already returns
   `monthLimit` and `dayLimit` before connection, so no new query is needed.

6. **Redact the Twilio error body.** `apps/web/convex/sms.ts:184-185` logs
   Twilio's raw JSON on failure, and Twilio's invalid-number errors quote the
   `To` number. The success path masks it; the failure path should too.

7. **Twilio console, before the flag flips.** Geo Permissions narrowed to
   `ALLOWED_DIAL_CODES`, account spend trigger set, sender-ID pre-registration
   checked per country (the UK needs none; several of the 31 allowlisted
   countries do), and message-body retention decided.

### STOP handling — do not assume Twilio covers it

`sms.ts:61-65` uses an alphanumeric sender ID, which is one-way. A STOP reply
goes nowhere. Twilio's automatic opt-out applies to long codes, toll-free and
short codes, not to this configuration. The terms must say replying STOP will
not reach us and point at Settings.

If a country later forces a long code, Twilio's default opt-out will start
blocking numbers with no signal back to `notificationSettings`, and an inbound
webhook becomes necessary. Not now.

## Phase 2 — fix the contradictions

The three above. Independent of SMS and arguably more urgent, since they are
live on a production site today.

Also in this phase:

- **`pushSubscriptions` survives account deletion.** Same bug class as
  `phoneVerifications`, same table sweep in `account.ts`. Audit every table in
  `schema.ts` against `deleteAllUserData` while in there rather than fixing two
  and leaving a third.

## Phase 3 — catch the policies up to what shipped

None of this is in either page. Verify each against the code before writing
copy; the list below is what the schema and commit history show.

**Data categories not disclosed**

| Thing | Where |
|---|---|
| Push subscription endpoints | `pushSubscriptions` |
| Telegram chat IDs, Discord webhook URLs | `notificationSettings`, `channelClaims` |
| Anonymous pre-signup scans and the email attached to them | `monitors.isAnonymous`, `monitors.anonymousEmail` |
| Public review display names | `reviews` |
| Match feedback | `matchFeedback` |
| Email send and delivery tracking | `emailSends` |
| Onboarding email sequence | `onboardingEmails` |
| Admin bulk email | `adminEmails` |
| Ban records | `bannedUsers` |
| Last-active tracking, and the inactivity auto-pause it drives | `userActivity` |
| Monitor creation rate limiting | `monitorCreations` |

**Processors not listed**

- **Scrapfly** — the blocked-site fallback (`apps/scraper/src/services/scraper.ts:85-94`).
  Page content goes through them. This is the biggest omission after Twilio.
- **Twilio** — Phase 1.
- **Telegram** and **Discord** — user-initiated, but chat IDs and webhook URLs
  leave our systems.
- **Vercel Analytics** — added in `8f476d5`, separate from PostHog.

**Terms drift**

- "Free accounts have limited features (3 monitors, hourly checks)" — check
  against `lib/plans.ts`, which now reads "3 monitors / 1 hour check interval /
  Email and push, plus Telegram, Discord or texts on one monitor".
- "Paid subscriptions are billed monthly via Polar" — the Sprint pass is a
  one-off 30-day Polar order, not a subscription. The cancellation and refund
  bullets do not describe it.
- Anonymous try-before-signup is not mentioned at all.
- Monitors being auto-paused for owner inactivity is not mentioned.
- Log retention windows (7/30/60/90 days by tier, PR #84) belong in the privacy
  policy's retention section. Note the subtlety: the window is enforced in the
  query, nothing is deleted, so "we keep logs for 7 days" would be false. Word
  it as what you can see, or make the deletion real.

## Phase 4 — structural gaps

These predate everything above and are worth closing while the pages are open.

- **No named controller.** The pages give a gmail address and nothing else.
  Decide whether the controller is James personally or J M Dimonaco LTD, and
  name it with an address.
- **No lawful basis stated** for any processing. For SMS: performance of
  contract (Art. 6(1)(b)) for the code and the alerts; legitimate interests
  (Art. 6(1)(f)) for the retained claim row and the send counters. Consent is
  not the right basis and is harder to run.
- **No international transfers section**, though Convex, Anthropic, Resend,
  PostHog (`us.i.posthog.com`), Vercel, Scrapfly and Twilio are US-based.
- **No right to complain to the ICO.**
- **"Governed by the laws of the United Kingdom"** is not a jurisdiction.
  England and Wales, Scotland, and Northern Ireland are.
- **ICO data protection fee** — applies to a controller processing personal
  data unless exempt. Email addresses already raised this in March.

## Regulatory read

Stated once, plainly:

- **PECR Reg. 22 does not apply** to these texts. They are transactional
  alerts the user configured and verified by code, with no promotional content.
  Not direct marketing. The one tripwire: never put "upgrade for more texts" in
  an SMS body. `formatQuotaExhaustedSms` is correctly service-only today —
  keep it that way.
- **UK GDPR Art. 13 does apply.** A phone number is personal data, a new
  processor is in the chain, and the transparency obligations are what Phases
  1-4 are mostly about.
- **Twilio's messaging policy** requires consent, an opt-out route and sender
  identification. The verification handshake is consent, every body starts
  "PageAlert:", and opt-out is the dashboard. Document it and it is met.
- **Recycled numbers.** A verified number reassigned by a carrier keeps getting
  alerts and the new holder cannot reply. The inactivity auto-pause bounds
  this. The contact email is the fallback; nothing more at this scale.

## Worth a solicitor's hour

Once, on the finished terms, not before: the governing-law clause, whether the
controller is James or the Ltd, and whether the liability cap reads as intended
under UK consumer law given free users have paid nothing. Everything else above
is copy and code that can ship without one.

## Appendix A — draft copy

Written to match the existing pages' register: plain, second person, no
legalese. Drop into the JSX prose as-is.

### Privacy — "What we collect", new paragraph

> If you turn on text alerts, we collect your **mobile number**. We send a code
> to it first, and only a number that answers the code gets alerts. We use it
> for nothing else.

### Privacy — "How we use your data", replacing the email bullet

> To send you notifications when matches are found, by email and by any other
> channel you connect (browser push, Telegram, Discord, text message)

### Privacy — third-party list, new entry after Resend

> **Twilio** — text message delivery. Twilio is based in the US and receives
> your mobile number and the content of each text (the monitor name, what
> changed, and a link). Twilio is certified under the UK–US data bridge and the
> EU–US Data Privacy Framework.

### Privacy — "Data retention", replacing the section

> Your monitor data and scrape results are retained as long as your account is
> active. Your mobile number stays on file while text alerts are on. If you turn
> them off on a free account, we keep the number only to stop one number being
> used across several free accounts, until you delete your account. A
> verification code you don't finish is deleted after it expires. If you delete
> your account, all associated data (monitors, results, notifications, phone
> number) is permanently removed.

The "deleted after it expires" sentence is false until Phase 1 item 2 lands.
Do not ship this paragraph without the sweep.

### Terms — new section after "Subscriptions and billing"

> **Text message alerts**
>
> - Text alerts are off until you add a mobile number in Settings and confirm
>   the code we send to it. Only the monitors you pick get texts.
> - Your mobile carrier may charge you to receive texts. Check your plan.
> - Each plan includes a monthly and daily text allowance; the current numbers
>   are on the pricing page and in Settings. When it runs out, alerts keep
>   coming by email and any other channel you have on, and texts resume when the
>   allowance resets.
> - We can text UK and EU numbers at the moment.
> - Turn texts off any time in Settings. Our texts come from a sender you can't
>   reply to, so replying STOP won't reach us.
> - Carriers can delay or drop texts. Don't rely on a text alone for anything
>   time-critical; the email alert is always sent as well.
> - On the free plan, one mobile number can be used on one account.

### Terms — "Limitation of liability", amended sentence

> We are not liable for missed or delayed notifications, inaccurate data
> extraction, carrier charges you incur, or any losses resulting from use of the
> Service.

### Settings card, under the number input

> We'll text a code to check it's yours. Standard message rates may apply. Your
> plan includes {monthLimit} texts a month, up to {dayLimit} a day; when they
> run out, alerts keep coming by email. Turn texts off any time here.

## Notes for whoever picks this up

- Bump "Last updated" on both pages. Currently March 2026 on each.
- The SMS feature is behind `SMS_ENABLED`, false on every deployment. The
  settings card and the channel chip are both gated on `api.sms.isEnabled`, so
  nothing is user-visible yet. There is room to do this properly.
- The undisclosed-processor list in Phase 3 was read from the schema and the
  scraper source. Re-verify before writing copy — this plan is a snapshot of
  2026-09-22 and the repo moves.
