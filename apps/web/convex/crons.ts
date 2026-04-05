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

export default crons;
