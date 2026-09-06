import { v } from "convex/values";
import { internalAction, action } from "./_generated/server";
import { displayHost } from "./shared";

const APP_URL = process.env.SITE_URL ?? "https://pagealert.io";
const TIMEOUT = 10_000;

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram bot not configured");
  return token;
}

/** Send a match alert via Telegram */
export const sendMatchAlert = internalAction({
  args: {
    chatId: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    url: v.string(),
    matchCount: v.number(),
    totalItems: v.number(),
  },
  handler: async (_ctx, args) => {
    const token = getBotToken();

    const text = [
      `🔔 *${escMd(args.monitorName)}*`,
      ``,
      `${args.matchCount} match${args.matchCount !== 1 ? "es" : ""} found out of ${args.totalItems} items`,
      ``,
      `🔗 [View on site](${escUrl(args.url)})`,
      `📊 [View in PageAlert](${escUrl(APP_URL + "/dashboard")})`,
    ].join("\n");

    await sendMessage(token, args.chatId, text);
  },
});

/** Send an error alert via Telegram */
export const sendErrorAlert = internalAction({
  args: {
    chatId: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    url: v.string(),
    error: v.string(),
  },
  handler: async (_ctx, args) => {
    const token = getBotToken();

    const text = [
      `⚠️ *${escMd(args.monitorName)}* — Monitor Error`,
      ``,
      `${escMd(args.error)}`,
      ``,
      `Retrying every 6 hours\\.`,
      ``,
      `🔗 [Check monitor](${escUrl(APP_URL + "/dashboard")})`,
    ].join("\n");

    await sendMessage(token, args.chatId, text);
  },
});

/** Send a "we have stopped checking this monitor" alert via Telegram */
export const sendMonitorStoppedAlert = internalAction({
  args: {
    chatId: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    url: v.string(),
  },
  handler: async (_ctx, args) => {
    const token = getBotToken();

    const text = [
      `🛑 *${escMd(args.monitorName)}* — Checks stopped`,
      ``,
      `${escMd(displayHost(args.url))} blocks automated access even through our proxy, so we have stopped checking it\\.`,
      ``,
      `No more alerts for this monitor until you start it again\\.`,
      ``,
      `🔗 [Retry this monitor](${escUrl(APP_URL + "/dashboard/monitors/" + args.monitorId)})`,
    ].join("\n");

    await sendMessage(token, args.chatId, text);
  },
});

/** Send a price change alert via Telegram */
export const sendPriceAlert = internalAction({
  args: {
    chatId: v.string(),
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
    const token = getBotToken();

    const lines: string[] = [];

    if (args.variant === "threshold") {
      lines.push(`🎯 *Price Target Hit — ${escMd(args.monitorName)}*`);
      lines.push("");

      if (args.belowHits.length > 0 && args.belowThreshold !== undefined) {
        lines.push(
          `⚡ Below your $${escMd(args.belowThreshold.toFixed(2))} threshold:`
        );
        lines.push("");
        for (const item of args.belowHits) {
          lines.push(`• ${escMd(item.title)}`);
          lines.push(
            `  now *$${escMd(item.newPrice.toFixed(2))}* \\(was ~$${escMd(item.oldPrice.toFixed(2))}~\\)`
          );
        }
      }

      if (args.aboveHits.length > 0 && args.aboveThreshold !== undefined) {
        if (args.belowHits.length > 0) lines.push("");
        lines.push(
          `⚡ Above your $${escMd(args.aboveThreshold.toFixed(2))} threshold:`
        );
        lines.push("");
        for (const item of args.aboveHits) {
          lines.push(`• ${escMd(item.title)}`);
          lines.push(
            `  now *$${escMd(item.newPrice.toFixed(2))}* \\(was ~$${escMd(item.oldPrice.toFixed(2))}~\\)`
          );
        }
      }
    } else if (args.variant === "single_drop" && args.priceChanges.length > 0) {
      lines.push(`📉 *Price Drop — ${escMd(args.monitorName)}*`);
      lines.push("");
      const item = args.priceChanges[0]!;
      const pct = Math.abs(item.changePercent).toFixed(1);
      lines.push(`• ${escMd(item.title)}`);
      lines.push(
        `  ~$${escMd(item.oldPrice.toFixed(2))}~ → *$${escMd(item.newPrice.toFixed(2))}* ▼${escMd(pct)}%`
      );
    } else {
      // multiple
      lines.push(`📊 *Price Changes — ${escMd(args.monitorName)}*`);
      lines.push("");

      const drops = args.priceChanges.filter((c) => c.change < 0);
      const increases = args.priceChanges.filter((c) => c.change > 0);

      if (drops.length > 0) {
        lines.push("📉 Drops:");
        for (const item of drops) {
          const pct = Math.abs(item.changePercent).toFixed(1);
          lines.push(`• ${escMd(item.title)}`);
          lines.push(
            `  ~$${escMd(item.oldPrice.toFixed(2))}~ → *$${escMd(item.newPrice.toFixed(2))}* ▼${escMd(pct)}%`
          );
        }
      }

      if (increases.length > 0) {
        if (drops.length > 0) lines.push("");
        lines.push("📈 Increases:");
        for (const item of increases) {
          const pct = Math.abs(item.changePercent).toFixed(1);
          lines.push(`• ${escMd(item.title)}`);
          lines.push(
            `  ~$${escMd(item.oldPrice.toFixed(2))}~ → *$${escMd(item.newPrice.toFixed(2))}* ▲${escMd(pct)}%`
          );
        }
      }
    }

    lines.push("");
    lines.push(
      `🔗 [View monitor](${escUrl(APP_URL + "/dashboard/monitors/" + args.monitorId)})`
    );

    await sendMessage(token, args.chatId, lines.join("\n"));
  },
});

/** Send a test message to verify the chat ID works */
export const sendTestMessage = action({
  args: { chatId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const token = getBotToken();

    const text = [
      `✅ *PageAlert connected\\!*`,
      ``,
      `You'll receive monitor alerts here\\.`,
      `[Open PageAlert](${escUrl(APP_URL + "/dashboard/settings")})`,
    ].join("\n");

    await sendMessage(token, args.chatId.trim(), text);
    return { sent: true };
  },
});

// ---- Helpers ----

async function sendMessage(token: string, chatId: string, text: string) {
  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    console.error("[telegram] Send failed:", res.status, body);

    // User hasn't pressed /start on the bot yet
    if (res.status === 403) {
      throw new Error("Please message @PageAlertNotify_bot on Telegram and press Start first, then try again");
    }
    throw new Error("Failed to send Telegram message");
  }
}

/** Escape MarkdownV2 special characters */
function escMd(str: string): string {
  return str.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/** Escape URL for MarkdownV2 link syntax — only escape parens */
function escUrl(url: string): string {
  return url.replace(/[()\\]/g, "\\$&");
}
