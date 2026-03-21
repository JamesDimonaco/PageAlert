import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { scrapeRoutes } from "./routes/scrape.js";
import { extractRoutes } from "./routes/extract.js";
import { checkRoutes } from "./routes/check.js";
import { quickCheckRoutes } from "./routes/quick-check.js";
import { authMiddleware } from "./middleware/auth.js";

export const app = new Hono();

app.use("*", logger());

// CORS: restrict to known origins. The scraper API is a backend service
// and should only be called from the Convex backend, not from browsers.
// In production, no browser origin should be allowed.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : [];

app.use(
  "*",
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : [],
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type", "x-api-key"],
    maxAge: 3600,
  })
);

app.get("/health", (c) => {
  return c.json({ status: "ok", service: "prowl-scraper", timestamp: new Date().toISOString() });
});

// API key auth for all /api routes
const api = new Hono();
api.use("*", authMiddleware);
api.route("/scrape", scrapeRoutes);
api.route("/extract", extractRoutes);
api.route("/check", checkRoutes);
api.route("/quick-check", quickCheckRoutes);

app.route("/api", api);
