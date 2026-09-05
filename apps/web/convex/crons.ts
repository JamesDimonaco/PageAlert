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

export default crons;
