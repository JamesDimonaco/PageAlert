import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { intervalToMs, MAX_RETRIES } from "./shared";

// ---- Resource Limits ----
const MAX_MONITORS_PER_USER = 50;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 200;
const MAX_PROMPT_LENGTH = 2000;
const MAX_RESULTS_LIMIT = 100;

async function getAuthUserId(ctx: { auth: { getUserIdentity: () => Promise<{ subject: string } | null> } }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity.subject;
}

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
  const blockedHosts = [
    "localhost", "127.0.0.1", "0.0.0.0", "[::1]",
    "metadata.google.internal", "169.254.169.254",
  ];
  if (blockedHosts.includes(hostname)) {
    throw new Error("This hostname is not allowed");
  }
  const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127 || (a === 169 && b === 254) || a === 0) {
      throw new Error("URLs pointing to private/internal IP addresses are not allowed");
    }
  }
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

const statusValidator = v.union(
  v.literal("scanning"),
  v.literal("active"),
  v.literal("paused"),
  v.literal("error"),
  v.literal("matched")
);

const intervalValidator = v.union(
  v.literal("5m"),
  v.literal("15m"),
  v.literal("30m"),
  v.literal("1h"),
  v.literal("6h"),
  v.literal("24h")
);

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

/** Create a monitor in "scanning" state. The scan runs client-side, then saveScanResult is called. */
export const create = mutation({
  args: {
    name: v.string(),
    url: v.string(),
    prompt: v.string(),
    checkInterval: intervalValidator,
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
      userId,
      status: "scanning",
      matchCount: 0,
      checkCount: 0,
      retryCount: 0,
      nextCheckAt: now + intervalToMs(args.checkInterval),
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Save scan results to a monitor. Transitions from "scanning" to "active"/"matched". */
export const saveScanResult = mutation({
  args: {
    id: v.id("monitors"),
    schema: v.any(),
    matchCount: v.number(),
  },
  handler: async (ctx, { id, schema, matchCount }) => {
    const userId = await getAuthUserId(ctx);
    const monitor = await ctx.db.get(id);
    if (!monitor || monitor.userId !== userId) throw new Error("Monitor not found");
    if (monitor.status !== "scanning") return;

    const now = Date.now();
    await ctx.db.patch(id, {
      schema,
      status: "active",
      matchCount,
      checkCount: (monitor.checkCount ?? 0) + 1,
      retryCount: 0,
      lastCheckedAt: now,
      lastMatchAt: matchCount > 0 ? now : undefined,
      nextCheckAt: now + intervalToMs(monitor.checkInterval),
      updatedAt: now,
    });
  },
});

/** Mark a scan as failed. */
export const saveScanError = mutation({
  args: {
    id: v.id("monitors"),
    error: v.string(),
  },
  handler: async (ctx, { id, error }) => {
    const userId = await getAuthUserId(ctx);
    const monitor = await ctx.db.get(id);
    if (!monitor || monitor.userId !== userId) throw new Error("Monitor not found");
    if (monitor.status !== "scanning") return;

    const retryCount = (monitor.retryCount ?? 0) + 1;
    const now = Date.now();

    if (retryCount >= MAX_RETRIES) {
      // Max retries exhausted — mark as error, stop scheduling
      await ctx.db.patch(id, {
        status: "error",
        lastError: error,
        retryCount,
        nextCheckAt: undefined,
        updatedAt: now,
      });
    } else {
      // Retry with exponential backoff: 2min, 8min, 32min
      const backoffMs = Math.pow(4, retryCount) * 30_000;
      await ctx.db.patch(id, {
        lastError: error,
        retryCount,
        nextCheckAt: now + backoffMs,
        updatedAt: now,
      });
    }
  },
});

export const update = mutation({
  args: {
    id: v.id("monitors"),
    name: v.optional(v.string()),
    url: v.optional(v.string()),
    prompt: v.optional(v.string()),
    status: v.optional(statusValidator),
    checkInterval: v.optional(intervalValidator),
    schema: v.optional(v.any()),
  },
  handler: async (ctx, { id, ...fields }) => {
    const userId = await getAuthUserId(ctx);
    const existing = await ctx.db.get(id);
    if (!existing || existing.userId !== userId) throw new Error("Monitor not found");

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

    const results = await ctx.db
      .query("scrapeResults")
      .withIndex("by_monitorId", (q) => q.eq("monitorId", id))
      .collect();
    for (const result of results) {
      await ctx.db.delete(result._id);
    }

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

export const updateBlacklist = mutation({
  args: {
    id: v.id("monitors"),
    blacklistedItems: v.array(v.string()),
  },
  handler: async (ctx, { id, blacklistedItems }) => {
    const userId = await getAuthUserId(ctx);
    const monitor = await ctx.db.get(id);
    if (!monitor || monitor.userId !== userId) throw new Error("Monitor not found");
    await ctx.db.patch(id, { blacklistedItems, updatedAt: Date.now() });
  },
});

export const getResults = query({
  args: { monitorId: v.id("monitors"), limit: v.optional(v.number()) },
  handler: async (ctx, { monitorId, limit }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const monitor = await ctx.db.get(monitorId);
    if (!monitor || monitor.userId !== identity.subject) return [];

    const safeLimit = Math.min(Math.max(limit ?? 20, 1), MAX_RESULTS_LIMIT);
    return ctx.db
      .query("scrapeResults")
      .withIndex("by_monitorId", (q) => q.eq("monitorId", monitorId))
      .order("desc")
      .take(safeLimit);
  },
});
