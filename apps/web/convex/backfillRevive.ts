/**
 * ONE-OFF BACKFILL — delete this file once it has been run against prod.
 *
 * Monitors that died before the recovery lane existed were parked with
 * `nextCheckAt: undefined`, which no index range picks up. This gives them a
 * due time so the scheduler drains them back into the normal cycle. Anonymous
 * scans are left alone: they were never meant to be scheduled.
 */
import { internalMutation } from "./_generated/server";
import { MAX_RETRIES } from "./shared";

export const reviveErroredMonitors = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stranded = await ctx.db
      .query("monitors")
      .withIndex("by_status_nextCheckAt", (q) => q.eq("status", "error").eq("nextCheckAt", undefined))
      .collect();

    const now = Date.now();
    let revived = 0;
    for (const monitor of stranded) {
      if (monitor.isAnonymous) continue;
      await ctx.db.patch(monitor._id, { retryCount: MAX_RETRIES, nextCheckAt: now, updatedAt: now });
      revived++;
    }

    return { stranded: stranded.length, revived };
  },
});
