import { v } from "convex/values";
import { internalAction, action } from "./_generated/server";

const APP_URL = process.env.SITE_URL ?? "https://pagealert.io";
const TIMEOUT = 10_000;

/** Send a match alert via Discord webhook */
export const sendMatchAlert = internalAction({
  args: {
    webhookUrl: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    url: v.string(),
    matchCount: v.number(),
    totalItems: v.number(),
  },
  handler: async (_ctx, args) => {
    await sendWebhook(args.webhookUrl, {
      embeds: [
        {
          title: `🔔 ${args.monitorName}`,
          description: `**${args.matchCount}** match${args.matchCount !== 1 ? "es" : ""} found out of ${args.totalItems} items`,
          color: 0x3b82f6,
          fields: [
            { name: "Website", value: `[Open](${args.url})`, inline: true },
            { name: "Dashboard", value: `[View](${APP_URL}/dashboard)`, inline: true },
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
            { name: "Dashboard", value: `[Check monitor](${APP_URL}/dashboard)`, inline: true },
          ],
          footer: { text: "Monitor paused after 3 failed attempts" },
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
