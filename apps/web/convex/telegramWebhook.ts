import { httpAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const APP_URL = process.env.SITE_URL ?? "https://pagealert.io";
const TIMEOUT = 5_000;

/**
 * Handles incoming Telegram Bot updates (webhook).
 * Commands: /start, /help, /monitors, /status
 */
export const handler = httpAction(async (ctx, request) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return new Response("Bot not configured", { status: 503 });
  }

  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return new Response("Webhook secret not configured", { status: 503 });
  }
  const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (headerSecret !== webhookSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const message = body.message as Record<string, unknown> | undefined;
  if (!message) return new Response("OK", { status: 200 });

  const chat = message.chat as Record<string, unknown> | undefined;
  const chatId = chat?.id;
  const text = String(message.text ?? "").trim();
  const firstName = String(chat?.first_name ?? "there");

  if (!chatId) return new Response("OK", { status: 200 });

  const send = async (msg: string, markdown = true) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        ...(markdown && { parse_mode: "Markdown" }),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) {
      const resBody = await res.text().catch(() => "");
      console.error("[telegram-webhook] Send failed:", res.status, resBody);
      throw new Error(`Telegram send failed: ${res.status}`);
    }
  };

  const safeName = String(firstName).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "");
  const esc = (s: string) => s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "");
  const command = text.split(" ")[0]?.toLowerCase();

  try {
    if (command === "/start") {
      await send([
        `Hey ${safeName}! 👋`,
        ``,
        `I'll send you alerts when your PageAlert monitors find matches.`,
        ``,
        `Your Chat ID is below — copy it and paste it into your notification settings:`,
        `🔗 ${APP_URL}/dashboard/settings`,
      ].join("\n"));
      await send(String(chatId), false);

    } else if (command === "/help") {
      await send([
        `*PageAlert Notification Bot*`,
        ``,
        `Commands:`,
        `/start — Get your Chat ID`,
        `/monitors — List your active monitors`,
        `/status — Quick summary of recent activity`,
        `/help — Show this message`,
        ``,
        `🔗 ${APP_URL}/dashboard`,
      ].join("\n"));

    } else if (command === "/monitors" || command === "/status") {
      const data = await ctx.runQuery(internal.telegramWebhook.getMonitorsByChatId, {
        chatId: String(chatId),
      });
      const monitors = (data ?? []) as Array<{ name: string; status: string; matchCount: number; checkCount?: number }>;

      if (monitors.length === 0) {
        await send([
          `No monitors linked to this chat yet.`,
          ``,
          `Add your Chat ID in PageAlert settings and enable Telegram on your monitors.`,
          `🔗 ${APP_URL}/dashboard/settings`,
        ].join("\n"));
      } else if (command === "/monitors") {
        const lines = monitors.map((m) => {
          const icon = m.status === "active" ? "🟢" : m.status === "paused" ? "⏸️" : m.status === "error" ? "🔴" : "⏳";
          return `${icon} *${esc(m.name)}* — ${m.matchCount} match${m.matchCount !== 1 ? "es" : ""}`;
        });
        await send([
          `*Your Monitors (${monitors.length})*`,
          ``,
          ...lines,
          ``,
          `🔗 ${APP_URL}/dashboard`,
        ].join("\n"));
      } else {
        const active = monitors.filter((m) => m.status === "active").length;
        const totalMatches = monitors.reduce((sum, m) => sum + m.matchCount, 0);
        const totalChecks = monitors.reduce((sum, m) => sum + (m.checkCount ?? 0), 0);
        await send([
          `*PageAlert Status*`,
          ``,
          `📊 ${monitors.length} monitor${monitors.length !== 1 ? "s" : ""} (${active} active)`,
          `🔍 ${totalChecks} total checks`,
          `✅ ${totalMatches} total matches`,
          ``,
          `🔗 ${APP_URL}/dashboard`,
        ].join("\n"));
      }

    } else {
      await send(`Your Chat ID is below — paste it into PageAlert settings:`);
      await send(String(chatId), false);
    }

    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error("[telegram-webhook] Handler error:", e);
    return new Response("Internal error", { status: 500 });
  }
});

/** Find monitors for a user linked to this Telegram chat ID */
export const getMonitorsByChatId = internalQuery({
  args: { chatId: v.string() },
  handler: async (ctx, args) => {
    const setting = await ctx.db
      .query("notificationSettings")
      .withIndex("by_channel_target", (q) =>
        q.eq("channel", "telegram").eq("target", args.chatId)
      )
      .unique();
    if (!setting || !setting.enabled) return [];

    // Get all monitors for this user
    const monitors = await ctx.db
      .query("monitors")
      .withIndex("by_userId", (q) => q.eq("userId", setting.userId))
      .collect();

    return monitors.map((m) => ({
      name: m.name,
      status: m.status,
      matchCount: m.matchCount,
      checkCount: m.checkCount ?? 0,
    }));
  },
});
