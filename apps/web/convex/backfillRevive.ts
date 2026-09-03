/**
 * ONE-OFF BACKFILL — delete this file once it has been run against prod.
 *
 * Monitors that died before the recovery lane existed were parked with
 * `nextCheckAt: undefined`, which no index range picks up. This gives them a
 * due time so the scheduler drains them (5/min) back into the normal cycle.
 */
import { internalMutation } from "./_generated/server";

export const reviveErroredMonitors = internalMutation({
  args: {},
  handler: async (ctx) => {
    const errored = await ctx.db
      .query("monitors")
      .withIndex("by_status", (q) => q.eq("status", "error"))
      .collect();

    const stranded = errored.filter((m) => m.nextCheckAt === undefined);
    const now = Date.now();

    for (const monitor of stranded) {
      await ctx.db.patch(monitor._id, {
        retryCount: 0,
        nextCheckAt: now,
        updatedAt: now,
      });
    }

    return { errored: errored.length, revived: stranded.length };
  },
});
