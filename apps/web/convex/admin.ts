/**
 * Operator tooling: Telegram alerts to James, scraper liveness, and the
 * one-off recovery tools for the 19 May 2026 outage (rerun never-scanned
 * monitors, grant a free Pro month, send the apology email).
 *
 * Run the one-offs from apps/web on the personal profile, in this order:
 *   npx convex run --prod admin:grantProMonth '{"dryRun":true}'
 *   npx convex run --prod admin:rerunNeverScanned '{"dryRun":true}'
 *   npx convex run --prod admin:sendApologyEmails '{"dryRun":true}'
 * Grant before rerun: the rerun relies on the paid-tier forced extract.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { APP_URL, esc, HELLO_FROM_EMAIL } from "./emails";
import { displayHost, isBlockedError } from "./shared";

const HOUR = 60 * 60 * 1000;

type MonitorSummary = { name: string; url: string; status: string; lastError?: string };
type NeverScanned = { _id: Id<"monitors">; name: string; url: string; status: string; userEmail?: string; lastError?: string };
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

/** Monthly ceiling on fallback calls. 6,000 is the Scrapfly Discovery plan at the worst-case 30 credits each. */
const FALLBACK_MONTHLY_CALLS = Number(process.env.FALLBACK_MONTHLY_CALLS ?? 6000);

/** Counts a fallback call against this month's budget. False, with one alert per month, when it is spent. */
export const reserveFallbackCall = internalMutation({
  args: {},
  handler: async (ctx) => {
    const month = new Date().toISOString().slice(0, 7);
    const key = `fallback:calls:${month}`;
    const row = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", key)).unique();
    const used = row?.value ?? 0;
    if (used >= FALLBACK_MONTHLY_CALLS) {
      const alertKey = `fallback:cap-alerted:${month}`;
      const alerted = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", alertKey)).unique();
      if (!alerted) {
        await ctx.db.insert("counters", { name: alertKey, value: Date.now() });
        await ctx.scheduler.runAfter(0, internal.admin.notify, {
          text: `PageAlert: fallback call budget for ${month} is spent (${FALLBACK_MONTHLY_CALLS}). Blocked sites will not be retried through Scrapfly until next month.`,
        });
      }
      return false;
    }
    if (row) await ctx.db.patch(row._id, { value: used + 1 });
    else await ctx.db.insert("counters", { name: key, value: 1 });
    return true;
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

/** Daily cron: drop expired manual grants back to free. Rows without a grant are untouched. */
export const expireGrants = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("userTiers").collect();
    let expired = 0;
    for (const r of rows) {
      if (!r.grantUntil || r.grantUntil > now) continue;
      await ctx.db.patch(r._id, { tier: "free", grantUntil: undefined, updatedAt: now });
      expired++;
    }
    return { expired };
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
      const html = `<div style="font-family:sans-serif;line-height:1.5;max-width:600px">${text
        .split("\n\n")
        .map((p) => `<p>${esc(p).replace(/\n/g, "<br>").replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>`)
        .join("")}</div>`;
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
