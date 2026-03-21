import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Run the scheduler every minute to check for monitors that are due
crons.interval(
  "check-monitors",
  { minutes: 1 },
  internal.scheduler.runScheduledChecks
);

export default crons;
