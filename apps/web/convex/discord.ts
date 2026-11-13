import { v } from "convex/values";
import { internalAction, action } from "./_generated/server";
import { displayHost } from "./shared";
import { formatDay, resumeUrl } from "./emails";

const APP_URL = process.env.SITE_URL ?? "https://pagealert.io";
const TIMEOUT = 10_000;

/**
 * Page text, made inert for a Discord embed: no markdown, links or mentions.
 * The "@" goes too, because a webhook pings @everyone unless told otherwise.
 */
function plainText(text: string): string {
  return text.replace(/[\\`*_~|>[\]()<@#]/g, "");
}

/** Send a match alert via Discord webhook */
export const sendMatchAlert = internalAction({
  args: {
    webhookUrl: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    url: v.string(),
    matchCount: v.number(),
    totalItems: v.number(),
    /** Set when stock was asked for and some matches did not show it. See stockNotShownNote. */
    stockNote: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    await sendWebhook(args.webhookUrl, {
      embeds: [
        {
          title: `🔔 ${args.monitorName}`,
          description: `**${args.matchCount}** new match${args.matchCount !== 1 ? "es" : ""} out of ${args.totalItems} items${args.stockNote ? `\n${plainText(args.stockNote)}` : ""}`,
          color: 0x3b82f6,
          fields: [
            { name: "Website", value: `[Open](${args.url})`, inline: true },
            { name: "Dashboard", value: `[View](${APP_URL}/dashboard/monitors/${args.monitorId})`, inline: true },
          ],
          footer: { text: "PageAlert" },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  },
});

/** A stock or price change on a watched product */
export const sendProductAlert = internalAction({
  args: {
    webhookUrl: v.string(),
    monitorId: v.string(),
    url: v.string(),
    headline: v.string(),
    message: v.string(),
  },
  handler: async (_ctx, args) => {
    await sendWebhook(args.webhookUrl, {
      embeds: [
        {
          title: args.headline,
          description: args.message,
          color: 0x047857,
          fields: [
            { name: "Website", value: `[Open](${args.url})`, inline: true },
            { name: "Dashboard", value: `[View](${APP_URL}/dashboard/monitors/${args.monitorId})`, inline: true },
          ],
          footer: { text: "PageAlert" },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  },
});

/** Send an error alert via Discord webhook */
export const sendErrorAlert = internalAction({
  args: {
    webhookUrl: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    url: v.string(),
    error: v.string(),
  },
  handler: async (_ctx, args) => {
    await sendWebhook(args.webhookUrl, {
      embeds: [
        {
          title: `⚠️ ${args.monitorName} — Error`,
          description: args.error,
          color: 0xef4444,
          fields: [
            { name: "Dashboard", value: `[Check monitor](${APP_URL}/dashboard/monitors/${args.monitorId})`, inline: true },
          ],
          footer: { text: "Retrying every 6 hours" },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  },
});

/** Send a "we have stopped checking this monitor" alert via Discord webhook */
export const sendMonitorStoppedAlert = internalAction({
  args: {
    webhookUrl: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    url: v.string(),
    /** Why checks stopped, from the park in scheduler.ts. */
    reason: v.string(),
  },
  handler: async (_ctx, args) => {
    await sendWebhook(args.webhookUrl, {
      embeds: [
        {
          title: `🛑 ${args.monitorName} — Checks stopped`,
          description: `We have stopped checking ${displayHost(args.url)}. ${args.reason} No more alerts for this monitor until you start it again.`,
          color: 0xf59e0b,
          fields: [
            { name: "Dashboard", value: `[Retry this monitor](${APP_URL}/dashboard/monitors/${args.monitorId})`, inline: true },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    });
  },
});

/** We have paused this monitor because the owner has not been back. */
export const sendInactivityPaused = internalAction({
  args: {
    webhookUrl: v.string(),
    monitorName: v.string(),
    url: v.string(),
    lastSeenAt: v.number(),
    /** Restart token — the link needs no login. See inactivity.ts. */
    token: v.string(),
  },
  handler: async (_ctx, args) => {
    await sendWebhook(args.webhookUrl, {
      embeds: [
        {
          title: `⏸️ ${args.monitorName} — Paused`,
          description: `You have not been back to PageAlert since ${formatDay(args.lastSeenAt)}, so we have stopped checking ${displayHost(args.url)}. Nothing is deleted.`,
          color: 0xf59e0b,
          fields: [
            { name: "Restart", value: `[Start checking again](${resumeUrl(args.token)})`, inline: true },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    });
  },
});

/** Send a test message to verify the webhook works */
export const sendTestMessage = action({
  args: { webhookUrl: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    if (!args.webhookUrl.startsWith("https://discord.com/api/webhooks/")) {
      throw new Error("Invalid Discord webhook URL");
    }

    await sendWebhook(args.webhookUrl, {
      embeds: [
        {
          title: "✅ PageAlert Connected!",
          description: "You'll receive monitor alerts in this channel.",
          color: 0x22c55e,
          footer: { text: "PageAlert" },
          timestamp: new Date().toISOString(),
        },
      ],
    });

    return { sent: true };
  },
});

// ---- Helpers ----

async function sendWebhook(url: string, body: Record<string, unknown>) {
  if (!url.startsWith("https://discord.com/api/webhooks/")) {
    throw new Error("Invalid Discord webhook URL");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[discord] Webhook failed:", res.status, text);
    throw new Error("Failed to send Discord message");
  }
}
