import { httpAction } from "./_generated/server";

/**
 * Handles incoming Telegram Bot updates (webhook).
 * When a user sends /start or any message, the bot replies with their Chat ID.
 */
export const handler = httpAction(async (_ctx, request) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return new Response("Bot not configured", { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const message = body.message as Record<string, unknown> | undefined;
  if (!message) {
    return new Response("OK", { status: 200 });
  }

  const chat = message.chat as Record<string, unknown> | undefined;
  const chatId = chat?.id;
  const text = String(message.text ?? "");
  const firstName = String(chat?.first_name ?? "there");

  if (!chatId) {
    return new Response("OK", { status: 200 });
  }

  let replyText: string;

  if (text === "/start" || text.startsWith("/start")) {
    replyText = [
      `Hey ${firstName}! 👋`,
      ``,
      `Your Chat ID is:`,
      `\`${chatId}\``,
      ``,
      `Copy this number and paste it into your PageAlert notification settings.`,
      ``,
      `🔗 pagealert.io/dashboard/settings`,
    ].join("\n");
  } else if (text === "/help") {
    replyText = [
      `PageAlert Notification Bot`,
      ``,
      `This bot sends you alerts when your monitors find matches.`,
      ``,
      `Your Chat ID: \`${chatId}\``,
      ``,
      `Commands:`,
      `/start — Get your Chat ID`,
      `/help — Show this message`,
    ].join("\n");
  } else {
    replyText = `Your Chat ID is \`${chatId}\`. Paste this into PageAlert settings to receive notifications here.`;
  }

  // Send reply via Telegram API
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: replyText,
      parse_mode: "Markdown",
    }),
  });

  return new Response("OK", { status: 200 });
});
