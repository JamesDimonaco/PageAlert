import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

export async function authMiddleware(c: Context, next: Next) {
  const expectedKey = process.env.SCRAPER_API_KEY;

  // SECURITY: Never skip auth. If the key is not configured, reject all requests.
  // This prevents accidentally running the scraper without authentication.
  if (!expectedKey || expectedKey.length === 0) {
    console.error("FATAL: SCRAPER_API_KEY is not configured. Rejecting all requests.");
    return c.json({ error: "server_misconfigured", message: "Service is not properly configured" }, 503);
  }

  const apiKey = c.req.header("x-api-key");

  if (!apiKey) {
    return c.json({ error: "unauthorized", message: "API key is required" }, 401);
  }

  // Use timing-safe comparison to prevent timing attacks
  const keyBuffer = Buffer.from(apiKey);
  const expectedBuffer = Buffer.from(expectedKey);
  if (keyBuffer.length !== expectedBuffer.length || !timingSafeEqual(keyBuffer, expectedBuffer)) {
    return c.json({ error: "unauthorized", message: "Invalid API key" }, 401);
  }

  return next();
}
