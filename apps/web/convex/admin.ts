/**
 * Operator tooling: Telegram alerts to James, scraper liveness, and the
 * one-off recovery tools for the 19 May 2026 outage (rerun never-scanned
 * monitors, grant a free Pro month, send the apology email).
 *
 * Run the one-offs from apps/web on the personal profile, e.g.
 *   npx convex run --prod admin:rerunNeverScanned '{"dryRun":true}'
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { runFullExtract } from "./scheduler";
import { HELLO_FROM_EMAIL } from "./emails";

const HOUR = 60 * 60 * 1000;

type MonitorSummary = { name: string; url: string; status: string; lastError?: string };
type NeverScanned = { _id: Id<"monitors">; name: string; url: string; userEmail?: string; lastError?: string };
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
  handler: async (ctx) => {
    const errored = await ctx.db.query("monitors").withIndex("by_status", (q) => q.eq("status", "error")).collect();
    return errored
      .filter((m) => !m.isAnonymous && !m.schema)
      .map((m) => ({ _id: m._id, name: m.name, url: m.url, userEmail: m.userEmail, lastError: m.lastError }));
  },
});

/** Schedules a full extract through the blocked-site fallback for every never-scanned monitor, 20s apart. */
export const rerunNeverScanned = internalAction({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }) => {
    const list: NeverScanned[] = await ctx.runQuery(internal.admin.listNeverScanned, {});
    if (dryRun) return { count: list.length, monitors: list };
    for (const [i, m] of list.entries()) {
      await ctx.scheduler.runAfter(i * 20_000, internal.admin.rescanMonitor, { monitorId: m._id });
    }
    return { scheduled: list.length };
  },
});

export const rescanMonitor = internalAction({
  args: { monitorId: v.id("monitors") },
  handler: async (ctx, { monitorId }) => {
    const scraperUrl = process.env.SCRAPER_URL;
    const scraperKey = process.env.SCRAPER_API_KEY;
    if (!scraperUrl || !scraperKey) throw new Error("SCRAPER_URL or SCRAPER_API_KEY not configured");
    const monitor = await ctx.runQuery(internal.monitors.getInternal, { id: monitorId });
    if (!monitor) return { skipped: "deleted" };
    try {
      // retryAttempt 1 + useProxy sends it straight to the fallback provider.
      const result = await runFullExtract(ctx, monitor, scraperUrl, scraperKey, 1, {
        skipQuickCheck: true,
        useProxy: true,
      });
      console.log(`[admin] Rescan ${monitorId}: ${result.totalItems ?? 0} items, ${result.matchCount} matches`);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error(`[admin] Rescan ${monitorId} failed:`, msg);
      await ctx.runMutation(internal.scheduler.recordCheckResult, {
        monitorId,
        hasNewMatches: false,
        matchCount: 0,
        totalItems: 0,
        matches: [],
        error: msg,
      });
      return { error: msg };
    }
  },
});

// ---- Outage recovery: free Pro month for everyone who built a monitor ----

export const grantProMonth = internalMutation({
  args: { dryRun: v.optional(v.boolean()), days: v.optional(v.number()) },
  handler: async (ctx, { dryRun, days }) => {
    const monitors = await ctx.db.query("monitors").collect();
    const userIds = [...new Set(monitors.filter((m) => !m.isAnonymous).map((m) => m.userId))];
    const now = Date.now();
    const periodEnd = now + (days ?? 30) * 24 * HOUR;
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
      // cancelledAt + periodEnd is what the settings page reads as
      // "You have access until <date>", and what expireGrants reverts.
      const patch = { tier: "pro" as const, cancelledAt: now, periodEnd, updatedAt: now };
      if (existing) await ctx.db.patch(existing._id, patch);
      else await ctx.db.insert("userTiers", { userId, ...patch });
    }
    return { users: userIds.length, granted, skippedAlreadyPaid: skipped.length, dryRun: !!dryRun };
  },
});

/** Daily cron: drop expired manual grants back to free. Polar subscriptions are untouched. */
export const expireGrants = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("userTiers").collect();
    let expired = 0;
    for (const r of rows) {
      if (r.tier === "free" || r.polarSubscriptionId || !r.periodEnd || r.periodEnd > now) continue;
      await ctx.db.patch(r._id, { tier: "free", periodEnd: undefined, cancelledAt: undefined, updatedAt: now });
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
  let host = m.url;
  try {
    host = new URL(m.url).hostname.replace(/^www\./, "");
  } catch {
    /* keep raw */
  }
  const blocked = /blocking automated access|CAPTCHA|Cloudflare|Access denied/i.test(m.lastError ?? "");
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
    "Your account now has Pro for the next 30 days, free. No card, nothing to cancel; it just drops back to the free plan afterwards.",
    "",
    "If you no longer need a monitor, delete it from your dashboard. If something looks wrong, reply to this email and I'll look at it myself.",
    "",
    "James",
    "PageAlert",
  ].join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const sendApologyEmails = internalAction({
  args: { dryRun: v.optional(v.boolean()), onlyTo: v.optional(v.string()) },
  handler: async (ctx, { dryRun, onlyTo }) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY not configured");
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
        .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
        .join("")}</div>`;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          from: HELLO_FROM_EMAIL,
          to: [r.email],
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
