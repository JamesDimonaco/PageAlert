# WhatsApp alerts

**Status:** Plan only. No code written.
**Created:** 2026-10-05
**Blocks on:** Meta business verification (weeks, outside the code)

## Read this first

- Longest lead: **Meta business verification.** Twilio says it "can take
  several weeks". Start it today. Everything else is hours.
- Cost per alert is lower than SMS. US about $0.008, UK about $0.026,
  against our $0.056 UK SMS. EU rates are not confirmed (see Pricing).
- Alerts are business-initiated, so every one needs an approved
  **utility** template. Wording must stay non-promotional or Meta
  re-files it as marketing, which costs more.
- The toll-free number probably cannot be the sender. Plan on a second
  number.
- Code changes are small: one new file, a few union edits, one schema field.

## Manual steps for James, in order

1. **Meta Business Portfolio.** Create or reuse one for J M Dimonaco LTD.
   Start **business verification** (Companies House number, address,
   website, a domain email). This is the long pole.
2. **Pick a sender number.** It must not already be on WhatsApp, and must
   receive an SMS or voice call for the one-time check. Twilio's docs do
   not say whether toll-free works. Do not assume it. Ask Twilio support,
   or buy a cheap local number just for WhatsApp.
3. **Twilio Self Sign-up** (Console, Messaging, Senders, WhatsApp). Needs
   an upgraded account and admin on the Meta portfolio. Link the number.
4. **Display name.** Ask for "PageAlert". Meta reviews it after
   registration. If rejected, the sender is capped at 250 messages per 24h.
   Risk: another product is called "Page Alert" (see memory note). Have a
   fallback such as "PageAlert Alerts".
5. **Content Templates** in Twilio Console, category **Utility**. Drafts
   below. Approval is usually minutes. A template cannot be edited once
   submitted, so a typo means a new template.
6. **Status callback.** Point it at the same endpoint feat/043 adds.
7. **Env vars on Convex dev, then prod.** `WHATSAPP_ENABLED`,
   `TWILIO_WHATSAPP_FROM` (or a WhatsApp Messaging Service sid),
   `TWILIO_WA_MATCH_CONTENT_SID`, `TWILIO_WA_PRICE_CONTENT_SID`,
   `TWILIO_WA_CODE_CONTENT_SID`. Flag stays off until step 8 passes.
8. **Send a test** to your own phone from the console before flipping on.

Note: one Twilio account maps to one WhatsApp Business Account. Fine for us.

## Templates

Utility rules from Meta: non-promotional, and tied to something the user
asked for. A monitor the user created fits. Mixed promo content is
re-categorised as marketing.

- **Match:** `Your PageAlert monitor "{{1}}" found {{2}} new match(es). View: {{3}}`
- **Price:** `PageAlert: price change on "{{1}}". {{2}}. View: {{3}}`
- **Code:** needs the **Authentication** category (one-time passcode only).
  Meta's template, not ours. It may carry a higher rate than utility.

Do not add "upgrade", "save", or "offer" wording. That is the usual cause of
re-categorisation or rejection. Other common causes: variables at the very
start or end, variable-only bodies, no sample values.

Variables are passed as `ContentSid` plus `ContentVariables`, a JSON string
with numbered keys: `{"1":"My monitor","2":"3","3":"https://..."}`.
Price text must be built into one variable, since the SMS formatter builds
one string today.

## Pricing (checked 2026-10-05)

| Item | Rate | Source |
| --- | --- | --- |
| Meta utility, North America | $0.0034 | Twilio pricing page, "as of Sept 2026" |
| Meta utility, UK | GBP 0.0159 (about $0.021) | Third-party sites only. Not on Meta's page. |
| Meta utility, EU markets | Not confirmed | Download Meta's EUR rate card |
| Twilio fee | $0.005 per message, in or out | Twilio pricing page |
| Our SMS, UK | about $0.056 | `tiers.ts` comment |

Per alert, outside the 24h window: **US about $0.0084, UK about $0.026.**
UK is roughly half of SMS. US is far cheaper. Plus VAT on UK invoices if
billed in GBP.

Facts that matter:

- Meta moved to per-message pricing on 2025-07-01. Charged on delivery,
  not on send. Only delivered messages are billed.
- Utility templates inside an open 24h window are free from Meta. Our
  users rarely message us first, so assume every alert is paid.
- Meta changes prices only on the first day of a quarter. Next is
  2027-01-01. 2026-10-01 had updates for some markets. Two third-party
  sites disagree on whether it changed utility-in-window pricing. Meta's
  page does not say so. Treat as unconfirmed, check the rate card.
- Volume tiers lower utility rates as monthly volume grows. Ignore at
  our size.
- Sources: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.md,
  https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing/,
  https://www.twilio.com/en-us/whatsapp/pricing

## Opt-in, STOP and blocks

- WhatsApp requires explicit opt-in. Our verified-number flow plus a
  clear "send me WhatsApp alerts" button counts. Put it in the privacy
  page and the settings card copy.
- There is no carrier-style STOP. Users block the number or reply with
  text. Twilio's docs say you must honour opt-out requests. Too many blocks
  lower the quality rating, then the sending limit, and can get templates
  paused (3 to 6 hours at first, permanent after three pauses).
- So: handle an inbound "stop" (needs an inbound webhook, or park it as a
  v2 item and put the opt-out in the settings card first), and treat a
  delivery failure for a blocked user as "disable the channel".
- Twilio fetch of its WhatsApp key concepts also notes new BSUID ids that
  stand in for phone numbers. We store phones, so no change now.

## Design

**Reuse**
- `normalisePhone`, `maskPhone`, dial-code allowlist, `PhoneError`.
- Verification state machine: `claimVerification`, `confirmVerification`,
  `releaseVerification`, `expireVerifications`, `channelClaims`.
- `reserveSmsSend` / `refundSmsSend`, `spendSmsBudget`, `SMS_LIMITS`.
- Scheduler fan-out: add one branch next to each `sms` branch.

**Does not fit**
- `postToTwilio` sends `Body` with a Messaging Service. WhatsApp needs
  `To=whatsapp:+...`, a WhatsApp sender, and `ContentSid` plus
  `ContentVariables`. Add a sibling function, do not bend the old one.
- The 160-char SMS formatters in `@prowl/shared` do not apply. WhatsApp
  sends variables, not a finished string.
- Whether a WhatsApp sender can join the existing Messaging Service is not
  confirmed by what I read. Twilio says a sender can be added to a
  Messaging Service, but SMS pool behaviour with a WhatsApp sender is
  untested. Start with `From=whatsapp:+number` and an env var. Move to a
  service only if there is a reason.

**Allowance: share the SMS one.**
Reasons: zero schema change, one number for James to reason about, and
WhatsApp costs less than SMS so the shared cap is conservative. Rename in
copy to "paid alerts" only if users get confused. Revisit if people ask
for both channels at full allowance. Same global budget
(`SMS_MONTHLY_BUDGET`). The cap-hit notice must go out on the channel
that hit it.

**Verification over WhatsApp itself: yes.**
Send the code with the authentication template. This also proves the
number is on WhatsApp, which SMS verification cannot. Same 3 codes per day,
same 5 guesses, same 10 minute expiry. An SMS-verified number does not count
as WhatsApp opt-in, so it needs its own code.
Cost per code is a Meta authentication rate plus $0.005. It counts against
`spendSmsCode` and `spendSmsBudget` as today.

## Code changes by file

All under `apps/web/convex/` unless noted.

- `whatsapp.ts` (new): `whatsappEnabled()`, `isEnabled` query,
  `postWhatsApp(to, contentSid, variables)`, `sendAlert` (copy the SMS
  reserve, send, refund shape), `sendMatchAlert`, `sendPriceAlert`,
  `startVerification`. To avoid copying, move `claimVerification`,
  `confirmVerification` and `releaseVerification` into a shared helper
  that takes a `channel`. Delete the SMS-only copies once moved.
- `sms.ts`: becomes thin or hands the shared verification to the helper.
  `normalisePhone` and `ALLOWED_DIAL_CODES` stay exported.
- `schema.ts`: add `"whatsapp"` to the channel unions at lines 71, 215,
  301. Add `channel` to `phoneVerifications` (index `by_userId` must key on
  user and channel, or a user cannot verify both at once).
- `notificationSettings.ts`: exclude `"whatsapp"` from `upsert` as for
  `sms`. Include it in disconnect, and delete its `channelClaims` row.
- `monitors.ts`: line 53 and 166 channel checks.
- `scheduler.ts`: next to lines 501, 607 and 760, add the WhatsApp branch.
  Also the validator at line 1432.
- Account deletion: purge whatsapp settings, claims and pending codes.
- `app/privacy` and `app/terms`: add WhatsApp as a channel and Meta as a
  processor. The legal refresh plan applies here too.
- Settings card UI: copy of the SMS card, gated by the `isEnabled` query.
- `.env.example`: the new vars.

## Tests (write first)

- Verification: a code sent on `sms` cannot confirm `whatsapp` (cross-channel).
- Refund: a failed WhatsApp send gives back the slot and the budget.
- Flag off or half-configured: nothing reserved (mirror the SMS test).
- Template variables: `ContentVariables` is valid JSON with keys 1..n.
- Mutation-check the refund and the shared cap.

## Failure alerting

Reuse feat/043. That branch has no commits yet (it points at main, in
`.claude/worktrees/agent-ae8527ff93a1c23ea`), so I could not read it. Plan
on its StatusCallback endpoint and pass `StatusCallback` on every WhatsApp
send. WhatsApp-specific: also alert on a template being paused or
rejected, and on quality rating drops. Those come from Meta's account
notifications, not Twilio. Set up the Meta email to a monitored address.

## Open questions for James

1. Can you start Meta business verification today? Companies House
   details ready?
2. Sender number: buy a new Twilio number for WhatsApp, or ask Twilio
   whether the toll-free works?
3. Display name: "PageAlert", or a fallback if Meta objects?
4. Shared SMS allowance, or its own? (Plan says shared.)
5. Which tiers get WhatsApp? Free tier too, or paid only? Free users cost
   about $0.03 per alert in the UK.
6. Opt-out: is a settings toggle enough for launch, or build the inbound
   "stop" webhook first?
7. Roll out to US and UK only first, since EU rates are unconfirmed?
