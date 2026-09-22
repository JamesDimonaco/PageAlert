import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Run the scheduler every minute to check for monitors that are due
crons.interval(
  "check-monitors",
  { minutes: 1 },
  internal.scheduler.runScheduledChecks
);

// Clean up expired anonymous monitors daily
crons.interval(
  "cleanup-anonymous",
  { hours: 24 },
  internal.anonymous.cleanupExpired
);

// Process pending onboarding emails (welcome sequence). The processor
// is internally gated by ONBOARDING_EMAILS_ENABLED so this is a no-op
// until the kill switch is flipped. See PROWL-038 Phase 4.
crons.interval(
  "process-onboarding-emails",
  { hours: 1 },
  internal.onboarding.processDueEmails
);

// Tell the operator when the scraper has been down for over an hour
crons.interval("scraper-health", { minutes: 10 }, internal.admin.checkScraperHealth);

// Drop expired manual Pro grants back to free
crons.interval("expire-tier-grants", { hours: 24 }, internal.admin.expireGrants);

// Pause monitors whose owners have gone. Gated by INACTIVITY_PAUSE_ENABLED —
// until that is "true" the run only logs what it would pause. See inactivity.ts.
// 10:00 UTC is the hour onboarding.ts already picked as globally inoffensive,
// and `daily` rather than `interval` so the run time cannot drift from a deploy.
crons.daily(
  "pause-dormant-monitors",
  { hourUTC: 10, minuteUTC: 0 },
  internal.inactivity.pauseDormant
);

// The morning digest: what happened to the business yesterday, one message.
// 08:00 UTC rather than 10:00 so it does not arrive alongside the reaper's.
crons.daily(
  "daily-pulse",
  { hourUTC: 8, minuteUTC: 0 },
  internal.pulse.dailyPulse
);

// Re-read Polar and grant anyone whose subscription the webhooks missed. The
// webhook path can only act on events it receives, so this is what stops a
// dropped subscription.created from billing someone indefinitely for free
// access. 07:30 UTC, so the pulse half an hour later counts the repaired tier.
//
// Gated by BILLING_RECONCILE_ENABLED — until that is "true" the run reports
// what it would change and writes nothing. Same shape as the two crons above.
crons.daily(
  "reconcile-billing",
  { hourUTC: 7, minuteUTC: 30 },
  internal.tiers.reconcile,
  {}
);

export default crons;
