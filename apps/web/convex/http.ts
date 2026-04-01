import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./betterAuth/auth";
import { handler as telegramWebhook } from "./telegramWebhook";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

// Telegram bot webhook — receives messages from @PageAlertNotify_bot
http.route({
  path: "/telegram/webhook",
  method: "POST",
  handler: telegramWebhook,
});

export default http;
