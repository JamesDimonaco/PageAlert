/**
 * Operator tooling: Telegram alerts to James, scraper liveness, the
 * one-off recovery tools for the 19 May 2026 outage (rerun never-scanned
 * monitors, grant a free Pro month, send the apology email), and the
 * super-admin dashboard backend (everything below "Super-admin dashboard";
 * each public function there calls requireAdmin, whose allow-list is the
 * SUPER_ADMIN_EMAILS Convex env var, comma-separated, case-insensitive).
 *
 * Run the one-offs from apps/web on the personal profile, in this order:
 *   npx convex run --prod admin:grantProMonth '{"dryRun":true}'
 *   npx convex run --prod admin:rerunNeverScanned '{"dryRun":true}'
 *   npx convex run --prod admin:sendApologyEmails '{"dryRun":true}'
 * Grant before rerun: the rerun relies on the paid-tier forced extract.
 */
import { v } from "convex/values";
import type { PaginationResult } from "convex/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { authComponent } from "./betterAuth/auth";
import { deleteAllUserData } from "./account";
import { APP_URL, HELLO_FROM_EMAIL, RESEND_TIMEOUT, textToHtmlParagraphs } from "./emails";
import { displayHost, isBlockedError } from "./shared";
import { effectiveTier, TIER_RANK, type Tier } from "./tiers";

const HOUR = 60 * 60 * 1000;

type MonitorSummary = { name: string; url: string; status: string; lastError?: string };
type NeverScanned = { _id: Id<"monitors">; name: string; url: string; status: string; userEmail?: string; lastError?: string };
/** Matches the scraper-health cron in crons.ts. */
const SCRAPER_HEALTH_INTERVAL_MS = 10 * 60 * 1000;
/** Cap on the delivery sample in `overview` — see the comment at its read. */
const EMAIL_SAMPLE_SIZE = 500;
const DOWN_SINCE = "admin:scraper-down-since";
const DOWN_ALERTED = "admin:scraper-down-alerted";

/** Plain-text Telegram message to the operator chat. Silent no-op until ADMIN_TELEGRAM_CHAT_ID is set. */
export const notify = internalAction({
  args: { text: v.string() },
  handler: async (_ctx, { text }) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.warn("[admin] ADMIN_TELEGRAM_CHAT_ID not set, dropping alert:", text.slice(0, 120));
      return;
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("[admin] Telegram send failed:", res.status, await res.text().catch(() => ""));
    }
  },
});

/** Rate limit for repeating alerts. True when the caller may send now. */
export const claimAlertSlot = internalMutation({
  args: { key: v.string(), minIntervalMs: v.number() },
  handler: async (ctx, { key, minIntervalMs }) => {
    const now = Date.now();
    const row = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", key)).unique();
    if (row && now - row.value < minIntervalMs) return false;
    if (row) await ctx.db.patch(row._id, { value: now });
    else await ctx.db.insert("counters", { name: key, value: now });
    return true;
  },
});

// ---- Blocked-site fallback budget ----

/** Monthly ceiling on fallback calls. 10,000 is ~135k Scrapfly credits at the observed 13.5 per call. */
const FALLBACK_MONTHLY_CALLS = Number(process.env.FALLBACK_MONTHLY_CALLS ?? 10000);

/**
 * Hourly ceiling on *escalations* — a monitor reaching for the proxy after a
 * block. The monthly cap cannot see a burst, and a burst is the shape the real
 * incident took: on 2026-09-05 a scraper fault made 67 monitors escalate inside
 * one hour, 113 calls. Escalation peaks at 26/hour in normal operation.
 *
 * Deliberately not applied to proxyPreferred checks. Those are steady, planned
 * traffic that scales with how many monitors sit on protected sites, so
 * counting them here would make an ordinary Tuesday look like a stampede — and
 * refusing one sends the monitor to a direct attempt that is certain to fail.
 * They still count against the monthly budget, which is the one about money.
 */
const FALLBACK_HOURLY_ESCALATIONS = Number(process.env.FALLBACK_HOURLY_ESCALATIONS ?? 60);

/**
 * Counts a fallback call against the budgets. False, with one operator alert
 * per period, when a budget is spent.
 */
export const reserveFallbackCall = internalMutation({
  args: {
    /** A reach for the proxy after a block, rather than a known-protected site's routine check. */
    escalation: v.boolean(),
  },
  handler: async (ctx, { escalation }) => {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const hour = now.toISOString().slice(0, 13);
    const prevHour = new Date(now.getTime() - 60 * 60 * 1000).toISOString().slice(0, 13);
    const get = (name: string) =>
      ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();

    const alertOnce = async (alertKey: string, text: string) => {
      const alerted = await get(alertKey);
      if (alerted) return;
      await ctx.db.insert("counters", { name: alertKey, value: Date.now() });
      await ctx.scheduler.runAfter(0, internal.admin.notify, { text });
    };

    const monthRow = await get(`fallback:calls:${month}`);
    const monthUsed = monthRow?.value ?? 0;
    if (monthUsed >= FALLBACK_MONTHLY_CALLS) {
      await alertOnce(
        `fallback:cap-alerted:${month}`,
        `PageAlert: fallback call budget for ${month} is spent (${FALLBACK_MONTHLY_CALLS}). Blocked sites will not be retried through Scrapfly until next month.`
      );
      return false;
    }

    let hourRow = null;
    if (escalation) {
      hourRow = await get(`fallback:escalations:${hour}`);
      const hourUsed = hourRow?.value ?? 0;
      if (hourUsed >= FALLBACK_HOURLY_ESCALATIONS) {
        await alertOnce(
          `fallback:hour-alerted:${hour}`,
          `PageAlert: ${FALLBACK_HOURLY_ESCALATIONS} proxy escalations in the hour to ${hour}:00Z — escalation paused until the next hour. Something is failing fleet-wide.`
        );
        return false;
      }
    }

    if (monthRow) await ctx.db.patch(monthRow._id, { value: monthUsed + 1 });
    else await ctx.db.insert("counters", { name: `fallback:calls:${month}`, value: 1 });

    if (escalation) {
      if (hourRow) await ctx.db.patch(hourRow._id, { value: hourRow.value + 1 });
      else {
        await ctx.db.insert("counters", { name: `fallback:escalations:${hour}`, value: 1 });
        // Rolling window of one hour, so the hour before it is finished with.
        // Left alone these rows accumulate at ~17k a year.
        for (const stale of [`fallback:escalations:${prevHour}`, `fallback:hour-alerted:${prevHour}`]) {
          const row = await get(stale);
          if (row) await ctx.db.delete(row._id);
        }
      }
    }
    return true;
  },
});

/**
 * True once the scraper has failed two consecutive health polls. One blip must
 * not disable proxy escalation fleet-wide, and recordScraperHealth sets
 * DOWN_SINCE on the very first failure.
 *
 * This only catches the scraper being unreachable. It has been known to answer
 * /health with a 200 while every scrape failed (a missing Playwright browser
 * after a deps bump), and that shape is caught by the hourly escalation cap
 * instead.
 */
export const isScraperDown = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", DOWN_SINCE))
      .unique();
    return row !== null && Date.now() - row.value >= SCRAPER_HEALTH_INTERVAL_MS;
  },
});

// ---- Scraper liveness (cron, every 10 minutes) ----

export const checkScraperHealth = internalAction({
  args: {},
  handler: async (ctx) => {
    const url = process.env.SCRAPER_URL;
    if (!url) return;
    let ok = false;
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000) });
      ok = res.ok;
    } catch {
      ok = false;
    }
    const transition = await ctx.runMutation(internal.admin.recordScraperHealth, { ok });
    if (transition === "down") {
      await ctx.runAction(internal.admin.notify, {
        text: `PageAlert: the scraper has been unreachable for over an hour. Every check is failing.\n${url}/health`,
      });
    } else if (transition === "recovered") {
      await ctx.runAction(internal.admin.notify, { text: "PageAlert: the scraper is reachable again." });
    }
  },
});

export const recordScraperHealth = internalMutation({
  args: { ok: v.boolean() },
  handler: async (ctx, { ok }) => {
    const now = Date.now();
    const get = (name: string) => ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();
    const since = await get(DOWN_SINCE);
    const alerted = await get(DOWN_ALERTED);
    if (ok) {
      if (since) await ctx.db.delete(since._id);
      if (alerted) {
        await ctx.db.delete(alerted._id);
        return "recovered";
      }
      return "ok";
    }
    if (!since) {
      await ctx.db.insert("counters", { name: DOWN_SINCE, value: now });
      return "failing";
    }
    if (!alerted && now - since.value >= HOUR) {
      await ctx.db.insert("counters", { name: DOWN_ALERTED, value: now });
      return "down";
    }
    return "failing";
  },
});

// ---- Outage recovery: rerun monitors that never had a successful first scan ----

export const listNeverScanned = internalQuery({
  args: {},
  handler: async (ctx): Promise<NeverScanned[]> => {
    const all = await ctx.db.query("monitors").collect();
    // No schema means the first extract never succeeded, whatever status the
    // failure left it in (a blocked first scan parks as active, not error).
    return all
      .filter((m) => !m.isAnonymous && !m.schema && m.status !== "paused")
      .map((m) => ({ _id: m._id, name: m.name, url: m.url, status: m.status, userEmail: m.userEmail, lastError: m.lastError }));
  },
});

/**
 * Makes every never-scanned monitor due now at retryCount 2, which is the
 * scheduler's "3rd attempt": a forced full extract through the blocked-site
 * fallback for paid tiers. Running through the normal cron keeps user
 * notifications and the single-lane concurrency. Grant Pro first.
 */
export const rerunNeverScanned = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }) => {
    const list: NeverScanned[] = await ctx.runQuery(internal.admin.listNeverScanned, {});
    if (dryRun) return { count: list.length, monitors: list };
    const now = Date.now();
    for (const m of list) {
      await ctx.db.patch(m._id, { retryCount: 2, nextCheckAt: now, updatedAt: now });
    }
    return { queued: list.length };
  },
});

// ---- Outage recovery: free Pro month for everyone who built a monitor ----

export const grantProMonth = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }) => {
    const monitors = await ctx.db.query("monitors").collect();
    const userIds = [...new Set(monitors.filter((m) => !m.isAnonymous).map((m) => m.userId))];
    const now = Date.now();
    const grantUntil = now + 30 * 24 * HOUR;
    let granted = 0;
    const skipped: string[] = [];
    for (const userId of userIds) {
      const existing = await ctx.db.query("userTiers").withIndex("by_userId", (q) => q.eq("userId", userId)).unique();
      if (existing && existing.tier !== "free") {
        skipped.push(userId);
        continue;
      }
      granted++;
      if (dryRun) continue;
      const patch = { tier: "pro" as const, grantUntil, updatedAt: now };
      if (existing) await ctx.db.patch(existing._id, patch);
      else await ctx.db.insert("userTiers", { userId, ...patch });
    }
    return { users: userIds.length, granted, skippedAlreadyPaid: skipped.length, dryRun: !!dryRun };
  },
});

/**
 * Daily cron: drop expired grants back to free. Rows without a grant are
 * untouched.
 *
 * Also slows any monitor left on an interval the free tier can't pick.
 * Interval limits are enforced when a monitor is written, never when it is
 * checked, so without this a lapsed £4 pass would keep ten monitors running
 * at 30 minutes forever — 480 checks a day, bought once.
 */
export const expireGrants = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("userTiers").collect();
    let expired = 0;
    let slowed = 0;
    for (const r of rows) {
      if (!r.grantUntil || r.grantUntil > now) continue;
      await ctx.db.patch(r._id, { tier: "free", grantUntil: undefined, grantSource: undefined, updatedAt: now });
      expired++;

      const monitors = await ctx.db
        .query("monitors")
        .withIndex("by_userId", (q) => q.eq("userId", r.userId))
        .collect();
      for (const m of monitors) {
        if (FREE_INTERVALS.includes(m.checkInterval)) continue;
        await ctx.db.patch(m._id, { checkInterval: FREE_SLOWEST_ALLOWED, updatedAt: now });
        slowed++;
      }
    }
    return { expired, slowed };
  },
});

// ---- Outage recovery: apology email, one per user ----

export const listApologyRecipients = internalQuery({
  args: {},
  handler: async (ctx) => {
    const monitors = await ctx.db.query("monitors").collect();
    const byEmail = new Map<string, MonitorSummary[]>();
    for (const m of monitors) {
      if (m.isAnonymous || !m.userEmail) continue;
      const list = byEmail.get(m.userEmail) ?? [];
      list.push({ name: m.name, url: m.url, status: m.status, lastError: m.lastError });
      byEmail.set(m.userEmail, list);
    }
    return [...byEmail.entries()].map(([email, monitors]) => ({ email, monitors }));
  },
});

function monitorLine(m: MonitorSummary): string {
  const host = displayHost(m.url);
  const blocked = isBlockedError(m.lastError ?? "");
  const state =
    m.status === "active"
      ? "watching again"
      : m.status === "paused"
        ? "paused, so left alone"
        : blocked
          ? "this site blocks automated visits; we're retrying with a different approach and will email you when it works"
          : "couldn't be reached on the last try; still retrying";
  return `${m.name} (${host}): ${state}`;
}

function apologyText(monitors: MonitorSummary[]): string {
  return [
    "Hi,",
    "",
    "PageAlert stopped checking pages on 19 May and I didn't catch it until this week. Every monitor you set up sat idle the whole time. I'm sorry.",
    "",
    "It's running again. Here's where your monitors stand:",
    "",
    ...monitors.map((m) => `- ${monitorLine(m)}`),
    "",
    `Your dashboard: ${APP_URL}/dashboard`,
    "",
    "Your account now has Pro for the next 30 days, free. No card, nothing to cancel; it just drops back to the free plan afterwards.",
    "",
    "If you no longer need a monitor, delete it from your dashboard. If something looks wrong, reply to this email and I'll look at it myself.",
    "",
    "James",
    "PageAlert",
  ].join("\n");
}

export const sendApologyEmails = internalAction({
  args: { dryRun: v.optional(v.boolean()), onlyTo: v.optional(v.string()) },
  handler: async (ctx, { dryRun, onlyTo }) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY not configured");
    // hello@ is send-only, so replies need somewhere real to land
    const replyTo = process.env.ADMIN_EMAIL;
    if (!replyTo) throw new Error("ADMIN_EMAIL not configured");
    let recipients: { email: string; monitors: MonitorSummary[] }[] = await ctx.runQuery(internal.admin.listApologyRecipients, {});
    if (onlyTo) recipients = recipients.filter((r) => r.email === onlyTo);
    if (dryRun) {
      return { recipients: recipients.length, preview: recipients[0] ? apologyText(recipients[0].monitors) : null };
    }
    let sent = 0;
    const failed: string[] = [];
    for (const r of recipients) {
      const text = apologyText(r.monitors);
      const html = `<div style="font-family:sans-serif;line-height:1.5;max-width:600px">${textToHtmlParagraphs(text)}</div>`;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          from: HELLO_FROM_EMAIL,
          to: [r.email],
          reply_to: replyTo,
          subject: "PageAlert was down. Your monitors are back, with a free month of Pro",
          html,
          text,
        }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      if (res?.ok) sent++;
      else failed.push(r.email);
      // Resend's default rate limit is 2 requests per second
      await new Promise((r) => setTimeout(r, 600));
    }
    return { sent, failed };
  },
});

// ---------------------------------------------------------------------------
// Super-admin dashboard (/admin)
// ---------------------------------------------------------------------------


const DAY_MS = 24 * HOUR;

// Mirrors TIER_LIMITS.free.allowedIntervals in convex/monitors.ts
const FREE_INTERVALS = ["1h", "6h", "24h"];
const FREE_SLOWEST_ALLOWED = "1h" as const;

// Monthly price in USD cents. Keep in step with lib/plans.ts (whole-dollar
// marketing prices); integer minor units here so MRR never touches a float.
// A Sprint pass is a single $4 payment for 30 days, not a subscription, so it
// contributes nothing to a figure called MRR. It shows in the tier counts
// instead, and the users table renders "–" against it rather than a monthly.
const TIER_PRICE_CENTS: Record<Tier, number> = { free: 0, sprint: 0, pro: 900, max: 2900 };

function adminAllowList(): Set<string> {
  return new Set(
    (process.env.SUPER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

type AnyCtx = QueryCtx | MutationCtx | ActionCtx;

async function callerAdminEmail(ctx: AnyCtx): Promise<string | null> {
  const user = await authComponent.safeGetAuthUser(ctx);
  const email = user?.email?.toLowerCase();
  if (!email || !adminAllowList().has(email)) return null;
  return email;
}

/**
 * Throws unless the caller's email is in SUPER_ADMIN_EMAILS. Returns that email.
 * Exported so the adminEmails/adminMonitors modules gate on the same allow-list
 * rather than each keeping its own copy of the check.
 */
export async function requireAdmin(ctx: AnyCtx): Promise<string> {
  const email = await callerAdminEmail(ctx);
  if (!email) throw new Error("Not authorised");
  return email;
}

type AuthUser = { id: string; email: string; name: string; createdAt: number };

/**
 * Page through the Better Auth component's user table. Its `_id` is what
 * ctx.auth.getUserIdentity().subject returns, i.e. the userId stored on
 * monitors / userTiers.
 */
async function fetchAllUsers(ctx: QueryCtx | ActionCtx): Promise<AuthUser[]> {
  const users: AuthUser[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const result: PaginationResult<Record<string, unknown>> = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "user",
      paginationOpts: { numItems: 500, cursor },
    });
    for (const doc of result.page) {
      users.push({
        id: String(doc._id),
        email: String(doc.email ?? ""),
        name: String(doc.name ?? ""),
        createdAt: Number(doc.createdAt ?? doc._creationTime),
      });
    }
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  return users;
}

/**
 * Most recent session.updatedAt per user, as a "last active" proxy —
 * Better Auth bumps it when a session is refreshed. Users who never
 * signed in again after their first session (or whose sessions expired
 * and were pruned) come back with no entry.
 */
async function fetchLastActiveByUser(ctx: QueryCtx | ActionCtx): Promise<Map<string, number>> {
  const lastActive = new Map<string, number>();
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const result: PaginationResult<Record<string, unknown>> = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "session",
      paginationOpts: { numItems: 500, cursor },
    });
    for (const doc of result.page) {
      const userId = String(doc.userId ?? "");
      const updatedAt = Number(doc.updatedAt ?? 0);
      if (!userId || !updatedAt) continue;
      const prev = lastActive.get(userId);
      if (!prev || updatedAt > prev) lastActive.set(userId, updatedAt);
    }
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  return lastActive;
}

/**
 * Has this user paid for what they currently have? True for a live
 * subscription, and for a bought pass — a pass is a purchase, so an admin
 * trial must not quietly overwrite one. An admin-granted trial is not.
 */
function isPayingRecord(t: { tier: Tier; grantUntil?: number; grantSource?: "admin" | "pass" }): boolean {
  if (effectiveTier(t) === "free") return false;
  if (!t.grantUntil) return true;
  return t.grantSource === "pass";
}

/**
 * Subscribed by every signed-in user's navbar, so this stays to one cheap
 * read (the identity claim) instead of authComponent's session-verified
 * lookup. Null means auth hasn't resolved yet, not "not an admin".
 */
export const isAdmin = query({
  args: {},
  handler: async (ctx): Promise<boolean | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const email = identity.email?.toLowerCase();
    return !!email && adminAllowList().has(email);
  },
});

export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const now = Date.now();
    const d7 = now - 7 * DAY_MS;
    const d30 = now - 30 * DAY_MS;

    const [users, allTiers, monitors] = await Promise.all([
      fetchAllUsers(ctx),
      ctx.db.query("userTiers").collect(),
      ctx.db.query("monitors").collect(),
    ]);
    // Drop rows for deleted accounts so they don't inflate MRR/plan counts
    const userIds = new Set(users.map((u) => u.id));
    const tiers = allTiers.filter((t) => userIds.has(t.userId));

    const signupsByDay = new Map<string, number>();
    for (let i = 29; i >= 0; i--) {
      signupsByDay.set(new Date(now - i * DAY_MS).toISOString().slice(0, 10), 0);
    }
    for (const u of users) {
      if (u.createdAt < d30) continue;
      const day = new Date(u.createdAt).toISOString().slice(0, 10);
      if (signupsByDay.has(day)) signupsByDay.set(day, (signupsByDay.get(day) ?? 0) + 1);
    }
    // Sum the buckets rather than re-filtering users, so this can never exceed the bars
    const new30d = [...signupsByDay.values()].reduce((sum, count) => sum + count, 0);

    const tierCounts: Record<Tier, number> = { free: 0, sprint: 0, pro: 0, max: 0 };
    let trials = 0;
    let cancelling = 0;
    let mrrCents = 0;
    const tieredUsers = new Set<string>();
    for (const t of tiers) {
      tieredUsers.add(t.userId);
      const eff = effectiveTier(t);
      tierCounts[eff]++;
      if (t.grantUntil && t.grantUntil > now) trials++;
      if (isPayingRecord(t)) {
        mrrCents += TIER_PRICE_CENTS[eff];
        if (t.cancelledAt) cancelling++;
      }
    }
    // Users with no userTiers row are on free
    tierCounts.free += users.filter((u) => !tieredUsers.has(u.id)).length;

    const statusCounts = { scanning: 0, active: 0, paused: 0, error: 0 };
    let anonymous = 0;
    let monitorsNew7d = 0;
    let totalChecks = 0;
    let totalMatches = 0;
    for (const m of monitors) {
      statusCounts[m.status]++;
      if (m.isAnonymous) anonymous++;
      if (m.createdAt >= d7) monitorsNew7d++;
      totalChecks += m.checkCount ?? 0;
      totalMatches += m.matchCount;
    }

    // scrapeLogs rows carry the raw AI response, so a wide read would blow
    // the query byte budget. Sample the most recent ones for a health read.
    const recentLogs = await ctx.db
      .query("scrapeLogs")
      .withIndex("by_createdAt")
      .order("desc")
      .take(200);
    const scans = { sampled: recentLogs.length, success: 0, error: 0, timeout: 0, blocked: 0 };
    for (const log of recentLogs) {
      scans[log.status]++;
      if (log.blocked) scans.blocked++;
    }

    // Delivery outcomes for a sample of recent sends. Bounded like the scan
    // sample above: this is a reactive query that re-runs on every insert, and
    // an unbounded read would take the whole dashboard down with it once
    // volume grows. "sent" means Resend accepted it and no webhook has landed
    // yet — a large standing figure there means the webhook is not wired up,
    // not that mail is stuck.
    const sends = await ctx.db
      .query("emailSends")
      .withIndex("by_createdAt")
      .order("desc")
      .take(EMAIL_SAMPLE_SIZE);
    const emails = { sampled: sends.length, sent: 0, failed: 0, delivered: 0, bounced: 0, complained: 0 };
    for (const s of sends) emails[s.status]++;

    return {
      users: {
        total: users.length,
        new7d: users.filter((u) => u.createdAt >= d7).length,
        new30d,
        signupsByDay: [...signupsByDay.entries()].map(([day, count]) => ({ day, count })),
      },
      emails,
      tiers: { ...tierCounts, trials, cancelling, mrrCents },
      monitors: {
        total: monitors.length,
        ...statusCounts,
        anonymous,
        new7d: monitorsNew7d,
        totalChecks,
        totalMatches,
      },
      scans,
    };
  },
});

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const now = Date.now();
    const [users, tiers, monitors, lastActiveByUser, bannedRows] = await Promise.all([
      fetchAllUsers(ctx),
      ctx.db.query("userTiers").collect(),
      ctx.db.query("monitors").collect(),
      fetchLastActiveByUser(ctx),
      ctx.db.query("bannedUsers").collect(),
    ]);
    const bannedByUser = new Map(bannedRows.map((b) => [b.userId, b]));

    const tierByUser = new Map(tiers.map((t) => [t.userId, t]));
    const monitorStats = new Map<string, { count: number; active: number; lastCreatedAt: number }>();
    for (const m of monitors) {
      if (m.isAnonymous) continue;
      const s = monitorStats.get(m.userId) ?? { count: 0, active: 0, lastCreatedAt: 0 };
      s.count++;
      if (m.status === "active" || m.status === "scanning") s.active++;
      s.lastCreatedAt = Math.max(s.lastCreatedAt, m.createdAt);
      monitorStats.set(m.userId, s);
    }

    return users
      .map((u) => {
        const t = tierByUser.get(u.id);
        const tier: Tier = effectiveTier(t);
        const s = monitorStats.get(u.id);
        return {
          userId: u.id,
          email: u.email,
          name: u.name,
          createdAt: u.createdAt,
          tier,
          grantUntil: t?.grantUntil && t.grantUntil > now ? t.grantUntil : null,
          isPaying: t ? isPayingRecord(t) : false,
          cancelledAt: t?.cancelledAt ?? null,
          periodEnd: t?.periodEnd ?? null,
          monthlyCents: t && isPayingRecord(t) ? TIER_PRICE_CENTS[tier] : 0,
          monitorCount: s?.count ?? 0,
          activeMonitors: s?.active ?? 0,
          lastMonitorAt: s?.lastCreatedAt ?? null,
          lastActiveAt: lastActiveByUser.get(u.id) ?? null,
          banned: bannedByUser.has(u.id),
          banReason: bannedByUser.get(u.id)?.reason ?? null,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

const paidTierValidator = v.union(v.literal("pro"), v.literal("max"));


/**
 * Grant (or extend) a free trial via grantUntil (the same field
 * grantProMonth uses; expireGrants reverts it). Users already paying for a
 * plan are skipped so we never clobber a real subscription. A user already
 * on a higher live grant keeps that tier — this only extends grantUntil.
 */
export const grantTrial = mutation({
  args: { userIds: v.array(v.string()), tier: paidTierValidator, days: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (!Number.isInteger(args.days) || args.days < 1 || args.days > 365) {
      throw new Error("Trial length must be between 1 and 365 days");
    }
    if (args.userIds.length === 0) throw new Error("No users selected");

    const now = Date.now();
    let granted = 0;
    let skippedPaying = 0;
    for (const userId of args.userIds) {
      const existing = await ctx.db
        .query("userTiers")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

      if (existing && isPayingRecord(existing)) {
        skippedPaying++;
        continue;
      }

      const tier =
        existing && existing.grantUntil && existing.grantUntil > now && TIER_RANK[effectiveTier(existing, now)] > TIER_RANK[args.tier]
          ? existing.tier
          : args.tier;

      // Same tier: extend the live window. Different tier: a fresh window, so
      // "Max for 7 days" on a long Pro grant is 7 days of Max, not 30.
      const liveGrant = existing?.grantUntil && existing.grantUntil > now ? existing.grantUntil : null;
      const base = liveGrant && existing?.tier === tier ? liveGrant : now;
      const grantUntil = base + args.days * DAY_MS;
      if (existing) {
        await ctx.db.patch(existing._id, {
          tier,
          grantUntil,
          grantSource: "admin" as const,
          cancelledAt: undefined,
          periodEnd: undefined,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("userTiers", { userId, tier: args.tier, grantUntil, updatedAt: now });
      }
      granted++;
    }
    return { granted, skippedPaying };
  },
});

export const endTrial = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!existing?.grantUntil) throw new Error("User is not on a trial");
    await ctx.db.patch(existing._id, { tier: "free", grantUntil: undefined, updatedAt: Date.now() });
  },
});

// ---------------------------------------------------------------------------
// Ban / delete users
// ---------------------------------------------------------------------------

/**
 * Blocks the user from creating new monitors or using the dashboard
 * (see monitors.create and account.myBanStatus) and pauses everything
 * they already have running, so a banned scraper stops burning budget
 * immediately. Idempotent — re-banning just updates the reason.
 */
export const banUser = mutation({
  args: { userId: v.string(), email: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, { userId, email, reason }) => {
    const adminEmail = await requireAdmin(ctx);
    const now = Date.now();
    const existing = await ctx.db
      .query("bannedUsers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { reason, bannedBy: adminEmail, bannedAt: now });
    } else {
      await ctx.db.insert("bannedUsers", { userId, email, reason, bannedBy: adminEmail, bannedAt: now });
    }

    const monitors = await ctx.db
      .query("monitors")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    let paused = 0;
    for (const m of monitors) {
      // "error" monitors sit in the scheduler's recovery lane and keep
      // getting retried until paused — not just "active"/"scanning"
      if (m.status === "active" || m.status === "scanning" || m.status === "error") {
        await ctx.db.patch(m._id, { status: "paused", updatedAt: now });
        paused++;
      }
    }
    return { paused };
  },
});

/** Lifts a ban. Does not resume paused monitors — the user does that themselves. */
export const unbanUser = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("bannedUsers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

type UserIdRow = { field: "userId"; operator: "eq"; value: string };

/** Deletes every matching row for a user, a page at a time until none remain. */
async function deleteAllRowsByUser(
  ctx: MutationCtx,
  input: { model: "session"; where: UserIdRow[] } | { model: "account"; where: UserIdRow[] },
): Promise<void> {
  for (let page = 0; page < 40; page++) {
    const result = await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input,
      paginationOpts: { numItems: 200, cursor: null },
    });
    if (result.count === 0 || result.isDone) break;
  }
}

/**
 * Permanently deletes the user's account and every row this app owns for
 * them (monitors, scrape results, notifications, settings, tier record),
 * plus their Better Auth session/account/user rows. Irreversible.
 */
export const deleteUser = mutation({
  args: { userId: v.string(), email: v.string() },
  handler: async (ctx, { userId, email }) => {
    const adminEmail = await requireAdmin(ctx);

    await deleteAllUserData(ctx, userId);

    const idFilter: UserIdRow[] = [{ field: "userId", operator: "eq", value: userId }];
    await deleteAllRowsByUser(ctx, { model: "session", where: idFilter });
    await deleteAllRowsByUser(ctx, { model: "account", where: idFilter });
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: "user", where: [{ field: "_id", operator: "eq", value: userId }] },
    });

    // Safe to drop the ban record here (unlike self-service deleteAccount):
    // the identity it was blocking no longer exists to reuse it.
    const banned = await ctx.db
      .query("bannedUsers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (banned) await ctx.db.delete(banned._id);

    await ctx.scheduler.runAfter(0, internal.admin.notify, {
      text: `PageAlert: ${adminEmail} deleted the account for ${email} (${userId}) from the admin dashboard.`,
    });
  },
});

// ---------------------------------------------------------------------------
// Bulk email from hello@
// ---------------------------------------------------------------------------

const SUBJECT_MAX = 200;
const BODY_MAX = 10_000;
const RESEND_BATCH_SIZE = 100;

/** Plain-text body → email. Blank lines split paragraphs; `{{name}}` is the recipient's first name. */
function renderBulkEmail(body: string, recipientName: string): { html: string; text: string } {
  const firstName = recipientName.trim().split(/\s+/)[0] || "there";
  // Function replacement so a `$`-pattern in the recipient's name isn't interpreted
  const text = body.replace(/\{\{\s*name\s*\}\}/gi, () => firstName);
  const paragraphs = textToHtmlParagraphs(text, "margin:0 0 16px;color:#333;font-size:16px;line-height:1.55");

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
      <div style="background:#4f46e5;padding:20px 32px">
        <p style="margin:0;color:#fff;font-size:18px;font-weight:600">PageAlert</p>
      </div>
      <div style="padding:32px">
        ${paragraphs}
      </div>
      <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #eee">
        <p style="margin:0;color:#999;font-size:12px">
          You're receiving this because you have a PageAlert account.
          <a href="${APP_URL}/dashboard/settings" style="color:#999">Account settings</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;

  return { html, text: `${text}\n\n— PageAlert\n${APP_URL}` };
}

export const sendBulkEmail = action({
  args: {
    userIds: v.array(v.string()),
    subject: v.string(),
    body: v.string(),
    // Send only to the admin, for checking the rendering before a real send
    testOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const adminEmail = await requireAdmin(ctx);
    const subject = args.subject.trim();
    const body = args.body.trim();
    if (!subject || subject.length > SUBJECT_MAX) throw new Error(`Subject must be 1–${SUBJECT_MAX} characters`);
    if (!body || body.length > BODY_MAX) throw new Error(`Body must be 1–${BODY_MAX} characters`);

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY not configured");
    // hello@ is send-only, so replies need somewhere real to land
    const replyTo = process.env.ADMIN_EMAIL;
    if (!replyTo) throw new Error("ADMIN_EMAIL not configured");

    let recipients: Array<{ email: string; name: string }>;
    if (args.testOnly) {
      recipients = [{ email: adminEmail, name: "" }];
    } else {
      const ids = [...new Set(args.userIds)];
      if (ids.length > 1000) throw new Error("Select at most 1000 users per send");
      const page: PaginationResult<Record<string, unknown>> = await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "user",
        where: [{ field: "_id", operator: "in", value: ids }],
        paginationOpts: { numItems: ids.length, cursor: null },
      });
      recipients = page.page
        .filter((u) => typeof u.email === "string" && u.email)
        .map((u) => ({ email: String(u.email), name: String(u.name ?? "") }));
    }
    if (recipients.length === 0) throw new Error("No recipients");

    const recordChunk = async (
      chunk: { email: string }[],
      ids: { id?: string }[],
      error?: string
    ) => {
      for (const [i, r] of chunk.entries()) {
        await ctx
          .runMutation(internal.emailEvents.recordSend, {
            to: r.email,
            kind: "bulk",
            resendId: ids[i]?.id,
            ok: !error,
            error,
          })
          .catch((e) => console.error("[admin] could not record bulk send:", e));
      }
    };

    let sent = 0;
    const failedRecipients: string[] = [];
    for (let i = 0; i < recipients.length; i += RESEND_BATCH_SIZE) {
      const chunk = recipients.slice(i, i + RESEND_BATCH_SIZE);
      const payload = chunk.map((r) => {
        const { html, text } = renderBulkEmail(body, r.name);
        return { from: HELLO_FROM_EMAIL, to: [r.email], reply_to: replyTo, subject, html, text };
      });
      const postBatch = () =>
        fetch("https://api.resend.com/emails/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(RESEND_TIMEOUT),
        });
      try {
        let res = await postBatch();
        if (res.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          res = await postBatch();
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          console.error("[admin] Resend batch failed:", res.status, detail);
          failedRecipients.push(...chunk.map((r) => r.email));
          await recordChunk(chunk, [], `Resend ${res.status}: ${detail.slice(0, 200)}`);
          continue;
        }
        // Batch replies carry one id per recipient, in the order they were
        // sent. Recording them is what lets the delivery webhook say whether a
        // blast actually landed.
        const data = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
        await recordChunk(chunk, data.data ?? []);
        sent += chunk.length;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[admin] Resend batch error:", msg);
        failedRecipients.push(...chunk.map((r) => r.email));
        await recordChunk(chunk, [], msg);
      }
      // Resend's default rate limit is 2 requests per second
      await new Promise((resolve) => setTimeout(resolve, 600));
    }

    if (!args.testOnly) {
      await ctx.runMutation(internal.admin.logEmail, {
        sentBy: adminEmail,
        subject,
        body,
        recipients: recipients.map((r) => r.email),
        failedRecipients,
      });
    }
    return { sent, failed: failedRecipients.length };
  },
});

export const logEmail = internalMutation({
  args: {
    sentBy: v.string(),
    subject: v.string(),
    body: v.string(),
    recipients: v.array(v.string()),
    failedRecipients: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("adminEmails", { ...args, sentAt: Date.now() });
  },
});

export const listSentEmails = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("adminEmails").withIndex("by_sentAt").order("desc").take(50);
    return rows.map((r) => ({
      _id: r._id,
      subject: r.subject,
      body: r.body,
      recipientCount: r.recipients.length,
      recipientsPreview: r.recipients.slice(0, 5),
      failedRecipients: r.failedRecipients,
      sentAt: r.sentAt,
    }));
  },
});
