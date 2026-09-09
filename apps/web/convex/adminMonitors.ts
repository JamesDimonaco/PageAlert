import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireAdmin } from "./admin";

/**
 * Super-admin monitor operations: monitors we have stopped checking, and
 * putting them back. Split out of admin.ts for the same reason as adminEmails.
 *
 * Every public function here must call requireAdmin from ./admin.
 */

// Bounded well above the handful of real parks (~11 in prod today), but still
// a hard cap so a regression that parks half the fleet can't turn this into a
// full table scan.
const MAX_PARKED = 200;

/** Monitors parked by recordCheckResult's MAX_PROXY_BLOCKS branch in scheduler.ts. */
export const parkedMonitors = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    // nextCheckAt: undefined is the parked signal, and undefined sorts before
    // every number in the index — the same fact getMonitorsDue relies on. So
    // parked monitors come first and the cap can only ever hide monitors that
    // are still being retried, never the ones this page exists to show.
    const errored = await ctx.db
      .query("monitors")
      .withIndex("by_status_nextCheckAt", (q) => q.eq("status", "error"))
      .take(MAX_PARKED);

    // Anonymous monitors also carry no nextCheckAt but were never scheduled in
    // the first place, so they'd otherwise show up as false positives.
    const parked = errored.filter((m) => m.nextCheckAt === undefined && !m.isAnonymous);
    parked.sort((a, b) => b.updatedAt - a.updatedAt);

    return parked.map((m) => ({
      _id: m._id,
      name: m.name,
      url: m.url,
      userEmail: m.userEmail,
      lastError: m.lastError,
      proxyBlockCount: m.proxyBlockCount,
      checkInterval: m.checkInterval,
      updatedAt: m.updatedAt,
      lastCheckedAt: m.lastCheckedAt,
    }));
  },
});

export const unparkMonitor = mutation({
  args: { monitorId: v.id("monitors") },
  handler: async (ctx, { monitorId }) => {
    await requireAdmin(ctx);

    const monitor = await ctx.db.get(monitorId);
    if (!monitor) throw new Error("Monitor not found");
    if (monitor.status !== "error" || monitor.nextCheckAt !== undefined) {
      throw new Error("This monitor is not parked");
    }

    const now = Date.now();
    await ctx.db.patch(monitorId, {
      status: "active",
      proxyBlockCount: 0,
      retryCount: 0,
      nextCheckAt: now,
      lastError: undefined,
      updatedAt: now,
    });

    // status: "active" (not "error") on purpose: getMonitorsDue reads active
    // monitors on the main lane (nextCheckAt <= now, capped at
    // MAX_CONCURRENT_CHECKS) but only ever admits one error-status monitor per
    // scheduler tick, held for the fleet's own slow retry lane. Leaving this as
    // "error" would queue it behind whatever else is already recovering
    // instead of checking it on the next run, and would keep the user's own
    // dashboard reporting a fault we've just told them is cleared.
    return { name: monitor.name };
  },
});
