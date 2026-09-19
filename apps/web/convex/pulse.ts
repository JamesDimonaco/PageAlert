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
 * Every read is bounded. This runs unattended forever, and an unbounded scan
 * would work fine at 107 users and fall over silently later.
 */
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { DAY_MS } from "@prowl/shared";
import { effectiveIntervalMs } from "./shared";
import { fetchAllUsers, isPayingRecord, TIER_PRICE_CENTS } from "./admin";
import { effectiveTier } from "./tiers";

/**
 * Recent rows sampled for the 24-hour figures. At ~110 checks and a handful of
 * emails a day this covers well over a day; the digest says "sampled" when it
 * does not, rather than quietly under-reporting.
 */
const LOG_SAMPLE = 500;
const EMAIL_SAMPLE = 200;

export const snapshot = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const since = now - DAY_MS;

    const [{ users }, tiers, monitors] = await Promise.all([
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
      if (m.createdAt >= since && !m.isAnonymous) monitorsNew++;
      if (m.autoPausedAt !== undefined) autoPaused++;
      if ((m.status === "active" || m.status === "error") && m.nextCheckAt !== undefined) {
        live++;
        checksPerDay += DAY_MS / effectiveIntervalMs(m);
      }
    }

    const logs = await ctx.db
      .query("scrapeLogs")
      .withIndex("by_createdAt")
      .order("desc")
      .take(LOG_SAMPLE);
    const recent = logs.filter((l) => l.createdAt >= since);
    const scans = { ok: 0, error: 0, timeout: 0, blocked: 0, matched: 0 };
    for (const l of recent) {
      scans[l.status === "success" ? "ok" : l.status]++;
      if (l.blocked) scans.blocked++;
      if ((l.matchCount ?? 0) > 0) scans.matched++;
    }

    const sends = await ctx.db
      .query("emailSends")
      .withIndex("by_createdAt")
      .order("desc")
      .take(EMAIL_SAMPLE);
    const recentSends = sends.filter((s) => s.createdAt >= since);
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
      monitorsNew,
      live,
      autoPaused,
      checksPerDay: Math.round(checksPerDay),
      scans,
      emails,
      // True when the sample did not reach back a full day, so the 24h figures
      // above are floors rather than counts.
      logsTruncated: logs.length === LOG_SAMPLE && recent.length === logs.length,
      sendsTruncated: sends.length === EMAIL_SAMPLE && recentSends.length === sends.length,
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

    const lines = [
      `PageAlert — ${day}`,
      ``,
      `Users      ${s.users}${plus(s.signups)}`,
      `Paying     ${s.paying} · MRR ${usd(s.mrrCents)}`,
      `Monitors   ${s.live} live of ${s.monitors}${plus(s.monitorsNew)}`,
      `Checks     ${s.checksPerDay}/day`,
      ``,
      `Last 24h${s.logsTruncated || s.sendsTruncated ? " (sampled)" : ""}`,
      `  scans    ${s.scans.ok} ok · ${s.scans.error + s.scans.timeout} failed · ${s.scans.blocked} blocked`,
      `  matches  ${s.scans.matched}`,
      `  emails   ${s.emails.sent} sent${s.emails.bad > 0 ? ` · ${s.emails.bad} BOUNCED` : ""}`,
    ];
    if (s.autoPaused > 0) lines.push(``, `${s.autoPaused} monitors auto-paused for inactivity`);

    await ctx.runAction(internal.admin.notify, { text: lines.join("\n") });
  },
});
