import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

async function getAuthUserId(ctx: { auth: { getUserIdentity: () => Promise<{ subject: string } | null> } }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity.subject;
}

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
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const now = Date.now();
    return ctx.db.insert("monitors", {
      ...args,
      userId,
      status: "active",
      matchCount: 0,
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

    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        updates[key] = value;
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

export const getResults = query({
  args: { monitorId: v.id("monitors"), limit: v.optional(v.number()) },
  handler: async (ctx, { monitorId, limit }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const monitor = await ctx.db.get(monitorId);
    if (!monitor || monitor.userId !== identity.subject) return [];
    return ctx.db
      .query("scrapeResults")
      .withIndex("by_monitorId", (q) => q.eq("monitorId", monitorId))
      .order("desc")
      .take(limit ?? 20);
  },
});
