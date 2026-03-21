import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ---- Resource Limits ----
const MAX_MONITORS_PER_USER = 50;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 200;
const MAX_PROMPT_LENGTH = 2000;
const MAX_RESULTS_LIMIT = 100;

// ---- Helpers ----

async function getAuthUserId(ctx: { auth: { getUserIdentity: () => Promise<{ subject: string } | null> } }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity.subject;
}

/**
 * Server-side URL validation for monitor URLs.
 * This runs in Convex mutations to ensure only safe URLs are stored,
 * independent of the scraper's own SSRF checks.
 */
function validateMonitorUrl(url: string): void {
  if (url.length > MAX_URL_LENGTH) {
    throw new Error(`URL exceeds maximum length of ${MAX_URL_LENGTH} characters`);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and private IPs
  const blockedHosts = [
    "localhost", "127.0.0.1", "0.0.0.0", "[::1]",
    "metadata.google.internal", "169.254.169.254",
  ];
  if (blockedHosts.includes(hostname)) {
    throw new Error("This hostname is not allowed");
  }

  // Block obvious private IP ranges
  const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      a === 0
    ) {
      throw new Error("URLs pointing to private/internal IP addresses are not allowed");
    }
  }

  // Must have a hostname with at least one dot (no bare hostnames like "intranet")
  if (!hostname.includes(".")) {
    throw new Error("URL must use a fully qualified domain name");
  }
}

function validateName(name: string): void {
  if (name.length === 0) throw new Error("Name is required");
  if (name.length > MAX_NAME_LENGTH) throw new Error(`Name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
}

function validatePrompt(prompt: string): void {
  if (prompt.length === 0) throw new Error("Prompt is required");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
}

// ---- Queries ----

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return ctx.db
      .query("monitors")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { id: v.id("monitors") },
  handler: async (ctx, { id }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const monitor = await ctx.db.get(id);
    if (!monitor || monitor.userId !== identity.subject) return null;
    return monitor;
  },
});

// ---- Mutations ----

export const create = mutation({
  args: {
    name: v.string(),
    url: v.string(),
    prompt: v.string(),
    checkInterval: v.union(
      v.literal("5m"),
      v.literal("15m"),
      v.literal("30m"),
      v.literal("1h"),
      v.literal("6h"),
      v.literal("24h")
    ),
    schema: v.optional(v.any()),
    initialMatchCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);

    validateName(args.name);
    validateMonitorUrl(args.url);
    validatePrompt(args.prompt);

    const existingMonitors = await ctx.db
      .query("monitors")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    if (existingMonitors.length >= MAX_MONITORS_PER_USER) {
      throw new Error(`You can have at most ${MAX_MONITORS_PER_USER} monitors. Please delete unused monitors first.`);
    }

    const now = Date.now();
    return ctx.db.insert("monitors", {
      name: args.name.trim(),
      url: args.url.trim(),
      prompt: args.prompt.trim(),
      checkInterval: args.checkInterval,
      schema: args.schema,
      userId,
      status: args.initialMatchCount ? "matched" : "active",
      matchCount: args.initialMatchCount ?? 0,
      lastCheckedAt: args.schema ? now : undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("monitors"),
    name: v.optional(v.string()),
    url: v.optional(v.string()),
    prompt: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("paused"),
        v.literal("error"),
        v.literal("matched")
      )
    ),
    checkInterval: v.optional(
      v.union(
        v.literal("5m"),
        v.literal("15m"),
        v.literal("30m"),
        v.literal("1h"),
        v.literal("6h"),
        v.literal("24h")
      )
    ),
  },
  handler: async (ctx, { id, ...fields }) => {
    const userId = await getAuthUserId(ctx);
    const existing = await ctx.db.get(id);
    if (!existing || existing.userId !== userId) throw new Error("Monitor not found");

    // Validate updated fields server-side
    if (fields.name !== undefined) validateName(fields.name);
    if (fields.url !== undefined) validateMonitorUrl(fields.url);
    if (fields.prompt !== undefined) validatePrompt(fields.prompt);

    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        updates[key] = typeof value === "string" ? value.trim() : value;
      }
    }

    await ctx.db.patch(id, updates);
    return id;
  },
});

export const remove = mutation({
  args: { id: v.id("monitors") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    const existing = await ctx.db.get(id);
    if (!existing || existing.userId !== userId) throw new Error("Monitor not found");

    // Cascading delete: remove related scrape results
    const results = await ctx.db
      .query("scrapeResults")
      .withIndex("by_monitorId", (q) => q.eq("monitorId", id))
      .collect();
    for (const result of results) {
      await ctx.db.delete(result._id);
    }

    // Cascading delete: remove related notifications
    const notifs = await ctx.db
      .query("notifications")
      .withIndex("by_monitorId", (q) => q.eq("monitorId", id))
      .collect();
    for (const notif of notifs) {
      await ctx.db.delete(notif._id);
    }

    await ctx.db.delete(id);
  },
});

export const getResults = query({
  args: { monitorId: v.id("monitors"), limit: v.optional(v.number()) },
  handler: async (ctx, { monitorId, limit }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const monitor = await ctx.db.get(monitorId);
    if (!monitor || monitor.userId !== identity.subject) return [];

    // Cap the limit to prevent excessive data retrieval
    const safeLimit = Math.min(Math.max(limit ?? 20, 1), MAX_RESULTS_LIMIT);
    return ctx.db
      .query("scrapeResults")
      .withIndex("by_monitorId", (q) => q.eq("monitorId", monitorId))
      .order("desc")
      .take(safeLimit);
  },
});
