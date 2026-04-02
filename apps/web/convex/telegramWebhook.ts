import { httpAction } from "./_generated/server";

const APP_URL = process.env.SITE_URL ?? "https://pagealert.io";
const TIMEOUT = 5_000;

/**
 * Handles incoming Telegram Bot updates (webhook).
 * When a user sends /start or any message, the bot replies with their Chat ID.
 */
export const handler = httpAction(async (_ctx, request) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return new Response("Bot not configured", { status: 503 });
  }

  // Verify webhook authenticity via secret token header
  // Fail closed — reject if secret not configured or mismatched
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[telegram-webhook] TELEGRAM_WEBHOOK_SECRET not configured");
    return new Response("Webhook secret not configured", { status: 503 });
  }
  const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (headerSecret !== webhookSecret) {
    console.error("[telegram-webhook] Invalid secret token");
    return new Response("Unauthorized", { status: 401 });
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

  const send = async (msg: string, markdown = true) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        ...(markdown && { parse_mode: "Markdown" }),
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[telegram-webhook] Send failed:", res.status, body);
      throw new Error(`Telegram send failed: ${res.status}`);
    }
  };

  // Escape markdown characters in user-provided text
  const safeName = String(firstName).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "");

  try {
    if (text === "/start" || text.startsWith("/start")) {
      await send([
        `Hey ${safeName}! 👋`,
        ``,
        `I'll send you alerts when your PageAlert monitors find matches.`,
        ``,
        `Your Chat ID is below — copy it and paste it into your notification settings:`,
        `🔗 ${APP_URL}/dashboard/settings`,
      ].join("\n"));

      // Send chat ID as a separate plain text message for easy copy-paste
      await send(String(chatId), false);
    } else if (text === "/help") {
      await send([
        `*PageAlert Notification Bot*`,
        ``,
        `This bot sends you alerts when your monitors find matches.`,
        ``,
        `Commands:`,
        `/start — Get your Chat ID`,
        `/help — Show this message`,
      ].join("\n"));

      await send(String(chatId), false);
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
