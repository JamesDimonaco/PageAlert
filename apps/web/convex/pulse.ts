/**
 * The daily operator digest — what happened to the business yesterday, as one
 * Telegram message at 08:00 UTC.
 *
 * Deliberately one message a day rather than a stream. The real-time alerts
 * elsewhere (a signup, a payment, a cancellation, a first scan) are the rare
 * events worth interrupting for; everything that is a number rather than an
 * event belongs here, where it can be read in ten seconds and skipped on a
 * busy morning.
 *
 * The sampled reads are capped and say so when a cap bites. The two full-table
 * reads (monitors, userTiers) are not, and are the first thing to page when
 * this deployment outgrows them — see the scale notes in admin.overview.
 */
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { DAY_MS } from "@prowl/shared";
import { effectiveIntervalMs } from "./shared";
import { fetchAllUsers, isPayingRecord, TIER_PRICE_CENTS } from "./admin";
import { effectiveTier } from "./tiers";

/**
 * Rows sampled for the 24-hour figures. The digest says "sampled" when a cap
 * bites, rather than quietly under-reporting.
 *
 * The scrapeLogs cap is the tight one and is deliberately no larger than
 * admin.overview's: those rows carry the raw AI response, so a wide read blows
 * the query's byte budget — and this query also collects every monitor and
 * tier row alongside. A digest that throws is worse than one that samples,
 * because the thing it exists to notice is a cron that stopped.
 */
const LOG_SAMPLE = 200;
const EMAIL_SAMPLE = 200;

export const snapshot = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const since = now - DAY_MS;

    const [{ users, complete }, tiers, monitors] = await Promise.all([
      fetchAllUsers(ctx),
      ctx.db.query("userTiers").collect(),
      ctx.db.query("monitors").collect(),
    ]);

    // Tier rows outlive deleted accounts, so filter to live users or MRR
    // counts ghosts — the same guard admin.overview uses.
    const liveUsers = new Set(users.map((u) => u.id));
    let mrrCents = 0;
    let paying = 0;
    for (const t of tiers) {
      if (!liveUsers.has(t.userId) || !isPayingRecord(t)) continue;
      paying++;
      mrrCents += TIER_PRICE_CENTS[effectiveTier(t)];
    }

    let live = 0;
    let checksPerDay = 0;
    let monitorsNew = 0;
    let autoPaused = 0;
    for (const m of monitors) {
      if (m.isAnonymous) continue; // claimWithEmail leaves these schedulable
      if (m.createdAt >= since) monitorsNew++;
      if (m.autoPausedAt !== undefined) autoPaused++;
      if ((m.status === "active" || m.status === "error") && m.nextCheckAt !== undefined) {
        live++;
        checksPerDay += DAY_MS / effectiveIntervalMs(m);
      }
    }

    // Bounded by the window as well as the cap, so a quiet day reads few rows
    // rather than always paying for LOG_SAMPLE of them.
    const recent = await ctx.db
      .query("scrapeLogs")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
      .take(LOG_SAMPLE);
    const scans = { ok: 0, error: 0, timeout: 0, blocked: 0, matched: 0 };
    for (const l of recent) {
      scans[l.status === "success" ? "ok" : l.status]++;
      if (l.blocked) scans.blocked++;
      if ((l.matchCount ?? 0) > 0) scans.matched++;
    }

    const recentSends = await ctx.db
      .query("emailSends")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
      .take(EMAIL_SAMPLE);
    const emails = {
      sent: recentSends.length,
      bad: recentSends.filter((s) => s.status === "failed" || s.status === "bounced" || s.status === "complained").length,
    };

    return {
      users: users.length,
      signups: users.filter((u) => u.createdAt >= since).length,
      paying,
      mrrCents,
      monitors: monitors.filter((m) => !m.isAnonymous).length,
      usersComplete: complete,
      monitorsNew,
      live,
      autoPaused,
      checksPerDay: Math.round(checksPerDay),
      scans,
      emails,
      // True when the sample did not reach back a full day, so the 24h figures
      // above are floors rather than counts.
      logsTruncated: recent.length === LOG_SAMPLE,
      sendsTruncated: recentSends.length === EMAIL_SAMPLE,
    };
  },
});

/** Whole dollars from integer cents. Money is never a float in this codebase. */
function usd(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function plus(n: number): string {
  return n > 0 ? ` (+${n})` : "";
}

export const dailyPulse = internalAction({
  args: {},
  handler: async (ctx) => {
    const s = await ctx.runQuery(internal.pulse.snapshot, {});
    const day = new Date().toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
    });

    // Two blocks, and the split is load-bearing: everything above the rule is a
    // standing total, everything below it happened in the last day. Mixing a
    // stock into the daily list reads as "34 paused yesterday" forever.
    const lines = [
      `PageAlert — ${day}`,
      ``,
      `Users      ${s.users}${plus(s.signups)}${s.usersComplete ? "" : " (partial)"}`,
      `Paying     ${s.paying} · MRR ${usd(s.mrrCents)}`,
      `Monitors   ${s.live} live of ${s.monitors}${plus(s.monitorsNew)}`,
      `Checks     ${s.checksPerDay}/day`,
    ];
    if (s.autoPaused > 0) lines.push(`Auto-paused ${s.autoPaused} (standing)`);
    lines.push(
      ``,
      `Last 24h${s.logsTruncated || s.sendsTruncated ? " (sampled)" : ""}`,
      `  scans    ${s.scans.ok} ok · ${s.scans.error + s.scans.timeout} failed · ${s.scans.blocked} blocked`,
      `  matches  ${s.scans.matched}`,
      `  emails   ${s.emails.sent} sent${s.emails.bad > 0 ? ` · ${s.emails.bad} BOUNCED` : ""}`,
    );

    await ctx.runAction(internal.admin.notify, { text: lines.join("\n") });
  },
});
