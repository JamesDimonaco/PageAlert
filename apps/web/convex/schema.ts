import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  monitors: defineTable({
    userId: v.string(), // Better Auth user subject ID from ctx.auth
    name: v.string(),
    url: v.string(),
    prompt: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("error"),
      v.literal("matched")
    ),
    checkInterval: v.union(
      v.literal("5m"),
      v.literal("15m"),
      v.literal("30m"),
      v.literal("1h"),
      v.literal("6h"),
      v.literal("24h")
    ),
    schema: v.optional(v.any()),
    lastCheckedAt: v.optional(v.number()),
    lastMatchAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    matchCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_status", ["status"])
    .index("by_userId_status", ["userId", "status"]),

  scrapeResults: defineTable({
    monitorId: v.id("monitors"),
    matches: v.array(v.any()),
    totalItems: v.number(),
    hasNewMatches: v.boolean(),
    scrapedAt: v.number(),
    error: v.optional(v.string()),
  })
    .index("by_monitorId", ["monitorId"])
    // Enables efficient time-ordered queries per monitor (e.g. "latest result for monitor X")
    .index("by_monitorId_scrapedAt", ["monitorId", "scrapedAt"]),

  notifications: defineTable({
    userId: v.string(),
    monitorId: v.id("monitors"),
    channel: v.union(
      v.literal("email"),
      v.literal("telegram"),
      v.literal("discord")
    ),
    title: v.string(),
    message: v.string(),
    sentAt: v.number(),
    read: v.boolean(),
  })
    .index("by_userId", ["userId"])
    .index("by_monitorId", ["monitorId"])
    // Enables efficient "unread notifications for user" queries
    .index("by_userId_read", ["userId", "read"]),

  notificationSettings: defineTable({
    userId: v.string(),
    channel: v.union(
      v.literal("email"),
      v.literal("telegram"),
      v.literal("discord")
    ),
    enabled: v.boolean(),
    target: v.string(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_channel", ["userId", "channel"]),
});
