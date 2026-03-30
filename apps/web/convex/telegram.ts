import { v } from "convex/values";
import { internalAction, action } from "./_generated/server";

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
      `The monitor has been paused after 3 failed attempts\\.`,
      ``,
      `🔗 [Check monitor](${escUrl(APP_URL + "/dashboard")})`,
    ].join("\n");

    await sendMessage(token, args.chatId, text);
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
