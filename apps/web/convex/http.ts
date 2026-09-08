import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./betterAuth/auth";
import { handler as telegramWebhook } from "./telegramWebhook";
import { handler as resendWebhook } from "./emailEvents";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

// Telegram bot webhook — receives messages from @PageAlertNotify_bot
http.route({
  path: "/telegram/webhook",
  method: "POST",
  handler: telegramWebhook,
});

// Resend delivery events — tells us whether an alert actually landed
http.route({
  path: "/resend/webhook",
  method: "POST",
  handler: resendWebhook,
});

export default http;
