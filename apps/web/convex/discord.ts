import { v } from "convex/values";
import { internalAction, action } from "./_generated/server";
import { displayHost } from "./shared";

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
  },
  handler: async (_ctx, args) => {
    await sendWebhook(args.webhookUrl, {
      embeds: [
        {
          title: `🛑 ${args.monitorName} — Checks stopped`,
          description: `${displayHost(args.url)} blocks automated access even through our proxy, so we have stopped checking it. No more alerts for this monitor until you start it again.`,
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

/** Send a price change alert via Discord webhook */
export const sendPriceAlert = internalAction({
  args: {
    webhookUrl: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    url: v.string(),
    variant: v.union(v.literal("threshold"), v.literal("single_drop"), v.literal("multiple")),
    priceChanges: v.array(
      v.object({
        title: v.string(),
        oldPrice: v.number(),
        newPrice: v.number(),
        change: v.number(),
        changePercent: v.number(),
      })
    ),
    belowThreshold: v.optional(v.number()),
    aboveThreshold: v.optional(v.number()),
    belowHits: v.array(
      v.object({
        title: v.string(),
        oldPrice: v.number(),
        newPrice: v.number(),
        change: v.number(),
        changePercent: v.number(),
      })
    ),
    aboveHits: v.array(
      v.object({
        title: v.string(),
        oldPrice: v.number(),
        newPrice: v.number(),
        change: v.number(),
        changePercent: v.number(),
      })
    ),
    trackedItemCount: v.number(),
  },
  handler: async (_ctx, args) => {
    let description = "";

    if (args.variant === "threshold") {
      const parts: string[] = [];

      if (args.belowHits.length > 0 && args.belowThreshold !== undefined) {
        parts.push(`⚡ Below your $${args.belowThreshold.toFixed(2)} threshold\n`);
        for (const item of args.belowHits) {
          parts.push(
            `**${item.title}** — now $${item.newPrice.toFixed(2)} (was $${item.oldPrice.toFixed(2)})`
          );
        }
      }

      if (args.aboveHits.length > 0 && args.aboveThreshold !== undefined) {
        if (parts.length > 0) parts.push("");
        parts.push(`⚡ Above your $${args.aboveThreshold.toFixed(2)} threshold\n`);
        for (const item of args.aboveHits) {
          parts.push(
            `**${item.title}** — now $${item.newPrice.toFixed(2)} (was $${item.oldPrice.toFixed(2)})`
          );
        }
      }

      description = parts.join("\n");
    } else if (args.variant === "single_drop" && args.priceChanges.length > 0) {
      const item = args.priceChanges[0]!;
      const pct = Math.abs(item.changePercent).toFixed(1);
      description = `**${item.title}**\n$${item.oldPrice.toFixed(2)} → $${item.newPrice.toFixed(2)} ▼ ${pct}%`;
    } else {
      // multiple
      const parts: string[] = [];
      const drops = args.priceChanges.filter((c) => c.change < 0);
      const increases = args.priceChanges.filter((c) => c.change > 0);

      if (drops.length > 0) {
        parts.push("📉 **Drops**");
        for (const item of drops) {
          const pct = Math.abs(item.changePercent).toFixed(1);
          parts.push(
            `• **${item.title}** — $${item.oldPrice.toFixed(2)} → $${item.newPrice.toFixed(2)} ▼ ${pct}%`
          );
        }
      }

      if (increases.length > 0) {
        if (parts.length > 0) parts.push("");
        parts.push("📈 **Increases**");
        for (const item of increases) {
          const pct = Math.abs(item.changePercent).toFixed(1);
          parts.push(
            `• **${item.title}** — $${item.oldPrice.toFixed(2)} → $${item.newPrice.toFixed(2)} ▲ ${pct}%`
          );
        }
      }

      description = parts.join("\n");
    }

    const title =
      args.variant === "threshold"
        ? "🎯 Price Target Hit!"
        : args.variant === "single_drop"
          ? "📉 Price Drop"
          : "📊 Price Changes";

    const color =
      args.variant === "threshold" || args.variant === "single_drop"
        ? 0x10b981
        : 0x3b82f6;

    await sendWebhook(args.webhookUrl, {
      embeds: [
        {
          title,
          description,
          color,
          fields: [
            { name: "Monitor", value: args.monitorName, inline: true },
            { name: "Website", value: `[Open](${args.url})`, inline: true },
            {
              name: "Dashboard",
              value: `[View](${APP_URL}/dashboard/monitors/${args.monitorId})`,
              inline: true,
            },
          ],
          footer: {
            text: `Tracking ${args.trackedItemCount} items · PageAlert`,
          },
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
