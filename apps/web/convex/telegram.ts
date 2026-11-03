import { v } from "convex/values";
import { internalAction, action } from "./_generated/server";
import { displayHost, MATCH_CONFIDENCE_LABEL, matchConfidence } from "./shared";
import { formatDay, resumeUrl } from "./emails";

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
    /** The entries named in the message, each with its position in the stored result row. */
    matches: v.optional(v.array(v.object({
      index: v.number(),
      title: v.string(),
      matchScore: v.optional(v.number()),
    }))),
    /** The result row the buttons point at. Without it the alert carries no buttons. */
    resultId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const token = getBotToken();
    const matches = args.matches ?? [];

    const itemLines = matches.map((m) => {
      const band = m.matchScore != null
        ? ` — _${escMd(MATCH_CONFIDENCE_LABEL[matchConfidence(m.matchScore)])}_`
        : "";
      return `• ${escMd(truncate(m.title, 80))}${band}`;
    });

    const text = [
      `🔔 *${escMd(args.monitorName)}*`,
      ``,
      `${args.matchCount} new match${args.matchCount !== 1 ? "es" : ""} out of ${args.totalItems} items`,
      ...(itemLines.length > 0 ? [``, ...itemLines] : []),
      ``,
      `🔗 [View on site](${escUrl(args.url)})`,
      `📊 [View in PageAlert](${escUrl(APP_URL + "/dashboard")})`,
    ].join("\n");

    // Feedback is only worth asking for where the answer can be tied back to
    // the entry it is about, which needs the stored row.
    const keyboard = args.resultId
      ? matches.map((m) => [
          { text: `👍 ${truncate(m.title, 20)}`, callback_data: `fb:g:${args.resultId}:${m.index}` },
          { text: "👎", callback_data: `fb:b:${args.resultId}:${m.index}` },
        ])
      : [];

    await sendMessage(token, args.chatId, text, keyboard);
  },
});

/** A stock or price change on a watched product */
export const sendProductAlert = internalAction({
  args: {
    chatId: v.string(),
    monitorId: v.string(),
    url: v.string(),
    headline: v.string(),
    message: v.string(),
  },
  handler: async (_ctx, args) => {
    const text = [
      `*${escMd(args.headline)}*`,
      ``,
      escMd(truncate(args.message, 300)),
      ``,
      `🔗 [View on site](${escUrl(args.url)})`,
      `📊 [View in PageAlert](${escUrl(APP_URL + "/dashboard/monitors/" + args.monitorId)})`,
    ].join("\n");

    await sendMessage(getBotToken(), args.chatId, text);
  },
});

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

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
    /** Why checks stopped, from the park in scheduler.ts. */
    reason: v.string(),
  },
  handler: async (_ctx, args) => {
    const token = getBotToken();

    const text = [
      `🛑 *${escMd(args.monitorName)}* — Checks stopped`,
      ``,
      `We have stopped checking ${escMd(displayHost(args.url))}\\. ${escMd(args.reason)}`,
      ``,
      `No more alerts for this monitor until you start it again\\.`,
      ``,
      `🔗 [Retry this monitor](${escUrl(APP_URL + "/dashboard/monitors/" + args.monitorId)})`,
    ].join("\n");

    await sendMessage(token, args.chatId, text);
  },
});

/**
 * We have paused this monitor because the owner has not been back. Telegram
 * matters here more than anywhere: a user who reads every alert on their phone
 * and never opens the app is exactly who this pause could blindside.
 */
export const sendInactivityPaused = internalAction({
  args: {
    chatId: v.string(),
    monitorName: v.string(),
    url: v.string(),
    lastSeenAt: v.number(),
    /** Restart token — the link needs no login. See inactivity.ts. */
    token: v.string(),
  },
  handler: async (_ctx, args) => {
    const token = getBotToken();

    const text = [
      `⏸ *${escMd(args.monitorName)}* — Paused`,
      ``,
      `You have not been back to PageAlert since ${escMd(formatDay(args.lastSeenAt))}, so we have stopped checking ${escMd(displayHost(args.url))}\\. Nothing is deleted\\.`,
      ``,
      `🔗 [Restart this monitor](${escUrl(resumeUrl(args.token))})`,
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

type InlineButton = { text: string; callback_data: string };

async function sendMessage(
  token: string,
  chatId: string,
  text: string,
  keyboard: InlineButton[][] = []
) {
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
        ...(keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
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
