import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { matchKey } from "./shared";

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

/** Live, and not a product's listing: those alert on their own stock and price read, never on matches. */
function wanted(m: { status: string; groupId?: unknown }) {
  return LIVE.has(m.status) && m.groupId === undefined;
}

/** Each live monitor's matched keys, to compare with after the re-reads. */
export const snapshotMatchKeys = internalQuery({
  args: {},
  handler: async (ctx) => {
    const monitors = await ctx.db.query("monitors").collect();
    return monitors
      .filter(wanted)
      .map((m) => ({ monitorId: m._id, name: m.name, matchedKeys: m.matchedKeys, candidateKeys: m.candidateKeys }));
  },
});

/**
 * Mark live monitors' AI re-read as due. Each then re-reads at its own next
 * check, through the scheduled path, which diffs against matchedKeys. Quick
 * checks only started adding their alerts to matchedKeys in this release, so
 * the ones they sent since the last full read are added here first, or the
 * re-read would announce them again. The page fingerprint is cleared too: a
 * quick check stops at an unchanged page before it asks whether a re-read is
 * due. A dry run unless dryRun is false.
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
    const live = monitors.filter(wanted);
    if (!dryRun) {
      for (const monitor of live) {
        let matchedKeys = monitor.matchedKeys;
        // Undefined means no baseline: the re-read then seeds it silently.
        if (matchedKeys !== undefined) {
          const sinceRead = await ctx.db
            .query("scrapeResults")
            .withIndex("by_monitorId_scrapedAt", (q) => q.eq("monitorId", monitor._id).gt("scrapedAt", monitor.lastAiExtractAt ?? 0))
            .order("desc")
            .take(500);
          const announced = sinceRead.filter((r) => r.hasNewMatches).flatMap((r) => r.matches.map(matchKey));
          matchedKeys = [...new Set([...matchedKeys, ...announced])];
        }
        await ctx.db.patch(monitor._id, {
          matchedKeys,
          lastAiExtractAt: 0,
          contentFingerprint: undefined,
          ...(checkNow ? { nextCheckAt: Date.now() } : {}),
        });
      }
    }
    return { dryRun, marked: live.length };
  },
});

/**
 * One-off: make the given live monitors due now. A dry run unless dryRun is
 * false. For product listings, which markReReadDue leaves out, whose first
 * price and stock read was a whole interval away.
 */
export const checkNow = internalMutation({
  args: { monitorIds: v.array(v.id("monitors")), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { monitorIds, dryRun = true }) => {
    const monitors = (await Promise.all(monitorIds.map((id) => ctx.db.get(id))))
      .filter((m) => m !== null)
      .filter((m) => LIVE.has(m.status));
    if (!dryRun) for (const m of monitors) await ctx.db.patch(m._id, { nextCheckAt: Date.now() });
    return { dryRun, marked: monitors.length };
  },
});

/**
 * One-off: remove matches the AI would now reject from a monitor's history,
 * so get_matches and get_recent_matches stop returning them. Matched by
 * matchKey. A dry run unless dryRun is false. Reads at most 500 rows, newest
 * first, which covers the history the match tools read.
 */
export const dropMatches = internalMutation({
  args: { monitorId: v.id("monitors"), keys: v.array(v.string()), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { monitorId, keys, dryRun = true }) => {
    const drop = new Set(keys);
    const rows = (
      await ctx.db
        .query("scrapeResults")
        .withIndex("by_monitorId_scrapedAt", (q) => q.eq("monitorId", monitorId))
        .order("desc")
        .take(500)
    ).filter((r) => r.matches.some((m) => drop.has(matchKey(m))));
    if (!dryRun) {
      for (const row of rows) {
        const matches = row.matches.filter((m) => !drop.has(matchKey(m)));
        await ctx.db.patch(row._id, {
          matches,
          hasNewMatches: matches.length > 0 && row.hasNewMatches,
          ...(row.newMatchKeys ? { newMatchKeys: row.newMatchKeys.filter((k) => !drop.has(k)) } : {}),
        });
      }
      const monitor = await ctx.db.get(monitorId);
      if (monitor) {
        await ctx.db.patch(monitorId, {
          ...(monitor.matchedKeys ? { matchedKeys: monitor.matchedKeys.filter((k) => !drop.has(k)) } : {}),
          ...(monitor.passedKeys ? { passedKeys: monitor.passedKeys.filter((k) => !drop.has(k)) } : {}),
        });
      }
    }
    return { dryRun, rows: rows.length };
  },
});
