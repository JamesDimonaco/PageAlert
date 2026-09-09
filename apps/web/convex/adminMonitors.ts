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
    // every number in the index — the same fact getMonitorsDue relies on, so
    // parked monitors come first.
    //
    // Anonymous scans sit in that same block: saveAnonymousError marks them
    // "error" and they never had a nextCheckAt. Excluding them in the query
    // rather than afterwards matters, because a scraper outage can leave
    // hundreds of them and they would otherwise consume the whole take budget
    // and hide the real parks — exactly when this page is worth opening.
    const errored = await ctx.db
      .query("monitors")
      .withIndex("by_status_nextCheckAt", (q) => q.eq("status", "error"))
      .filter((q) => q.neq(q.field("isAnonymous"), true))
      .take(MAX_PARKED);

    const parked = errored.filter((m) => m.nextCheckAt === undefined);
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
    // An errored anonymous scan looks identical to a park. parkedMonitors
    // filters them out, and this guard has to agree or the mutation would put
    // an ownerless scan on the paid schedule until it expires.
    if (monitor.isAnonymous) throw new Error("Anonymous scans cannot be un-parked");

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
