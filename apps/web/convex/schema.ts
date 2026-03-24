import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  monitors: defineTable({
    userId: v.string(), // Better Auth user subject ID from ctx.auth
    userEmail: v.optional(v.string()),
    name: v.string(),
    url: v.string(),
    prompt: v.string(),
    status: v.union(
      v.literal("scanning"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("error")
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
    blacklistedItems: v.optional(v.array(v.string())),
    lastCheckedAt: v.optional(v.number()),
    lastMatchAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    matchCount: v.number(),
    checkCount: v.optional(v.number()),
    retryCount: v.optional(v.number()),
    nextCheckAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_status", ["status"])
    .index("by_userId_status", ["userId", "status"])
    .index("by_nextCheckAt", ["nextCheckAt"]),

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

  scrapeLogs: defineTable({
    userId: v.string(),
    monitorId: v.optional(v.id("monitors")),
    monitorName: v.optional(v.string()),
    url: v.string(),
    prompt: v.string(),
    status: v.union(v.literal("success"), v.literal("error"), v.literal("timeout")),
    durationMs: v.number(),
    error: v.optional(v.string()),
    rawResponse: v.optional(v.string()),
    itemCount: v.optional(v.number()),
    matchCount: v.optional(v.number()),
    // AI insights
    aiConfidence: v.optional(v.number()),
    aiUnderstanding: v.optional(v.string()),
    aiMatchSignal: v.optional(v.string()),
    aiNoMatchSignal: v.optional(v.string()),
    aiNotices: v.optional(v.array(v.string())),
    // Match conditions the AI generated
    matchConditions: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_status", ["status"]),

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
