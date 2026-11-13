import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * One-off: give live monitors an AI re-read so they pick up stock-aware
 * matching (inStock on items, inStockOnly in the conditions).
 *
 * Run order, from docs/plans/mcp-gaps:
 * 1. snapshotMatchKeys, and keep the output.
 * 2. markReReadDue on the 7 "PC build" monitors with checkNow, and check the gate.
 * 3. Only if it passes, markReReadDue on everything, then compare with the snapshot.
 *
 * Paused monitors are left out: their stamp is past the 14-day re-read window
 * by the time anyone resumes them.
 */

const LIVE = new Set(["active", "error"]);

/** Each live monitor's matched keys, to compare with after the re-reads. */
export const snapshotMatchKeys = internalQuery({
  args: {},
  handler: async (ctx) => {
    const monitors = await ctx.db.query("monitors").collect();
    return monitors
      .filter((m) => LIVE.has(m.status))
      .map((m) => ({ monitorId: m._id, name: m.name, matchedKeys: m.matchedKeys, candidateKeys: m.candidateKeys }));
  },
});

/**
 * Mark live monitors' AI re-read as due. Each then re-reads at its own next
 * check, through the scheduled path, which diffs against the matches it has
 * already announced, so nothing is announced twice. A dry run unless dryRun
 * is false.
 */
export const markReReadDue = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    /** Only these monitors. For the gate on James's 7. */
    monitorIds: v.optional(v.array(v.id("monitors"))),
    /** Check now rather than at the next slot. For the gate only: on the whole fleet it would spike AI and proxy spend. */
    checkNow: v.optional(v.boolean()),
  },
  handler: async (ctx, { dryRun = true, monitorIds, checkNow = false }) => {
    const monitors = monitorIds
      ? (await Promise.all(monitorIds.map((id) => ctx.db.get(id)))).filter((m) => m !== null)
      : await ctx.db.query("monitors").collect();
    const live = monitors.filter((m) => LIVE.has(m.status));
    if (!dryRun) {
      for (const monitor of live) {
        await ctx.db.patch(monitor._id, { lastAiExtractAt: 0, ...(checkNow ? { nextCheckAt: Date.now() } : {}) });
      }
    }
    return { dryRun, marked: live.length };
  },
});
