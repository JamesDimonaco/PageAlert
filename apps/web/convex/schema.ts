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
    // SHA-256 of the page text from the last completed scan — used to skip
    // all downstream work (and AI) when the page hasn't changed
    contentFingerprint: v.optional(v.string()),
    // When the AI last re-read this page. Drives the drift refresh — see
    // AI_REEXTRACT_AFTER_MS in scheduler.ts. Absent on rows predating it.
    lastAiExtractAt: v.optional(v.number()),
    lastCheckedAt: v.optional(v.number()),
    lastMatchAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    matchCount: v.number(),
    checkCount: v.optional(v.number()),
    retryCount: v.optional(v.number()),
    // Confirmed Scrapfly (proxy) blocks in a row — see MAX_PROXY_BLOCKS in shared.ts
    proxyBlockCount: v.optional(v.number()),
    // Identities of the items matching last time, so a match alert can fire on
    // genuinely new items rather than only on the zero-to-something transition.
    // See matchKey/newMatchKeys in shared.ts. Undefined means "no baseline yet".
    matchedKeys: v.optional(v.array(v.string())),
    // This site only ever answers through the proxy, so skip the direct attempt
    // that would fail anyway. Re-probed periodically — see PROXY_REPROBE_EVERY.
    proxyPreferred: v.optional(v.boolean()),
    nextCheckAt: v.optional(v.number()),
    notificationChannels: v.optional(v.array(v.union(
      v.literal("email"),
      v.literal("telegram"),
      v.literal("discord"),
      v.literal("push")
    ))),
    isAnonymous: v.optional(v.boolean()),
    anonymousEmail: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    muted: v.optional(v.boolean()),
    priceAlerts: v.optional(v.object({
      onPriceDrop: v.boolean(),
      onPriceIncrease: v.boolean(),
      belowThreshold: v.optional(v.number()),
      aboveThreshold: v.optional(v.number()),
      trackedItems: v.array(v.string()),
      minChangePercent: v.optional(v.number()),
      lastNotifiedAt: v.optional(v.number()),
      cooldownMs: v.optional(v.number()),
    })),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_status", ["status"])
    .index("by_userId_status", ["userId", "status"])
    .index("by_nextCheckAt", ["nextCheckAt"])
    .index("by_status_nextCheckAt", ["status", "nextCheckAt"])
    .index("by_anonymousEmail", ["anonymousEmail"])
    .index("by_isAnonymous", ["isAnonymous"])
    .index("by_isAnonymous_expiresAt", ["isAnonymous", "expiresAt"]),

  scrapeResults: defineTable({
    monitorId: v.id("monitors"),
    matches: v.array(v.any()),
    items: v.optional(v.array(v.any())),
    totalItems: v.number(),
    hasNewMatches: v.boolean(),
    scrapedAt: v.number(),
    error: v.optional(v.string()),
    // Change detection from previous check
    changes: v.optional(v.object({
      added: v.array(v.any()),
      removed: v.array(v.any()),
      priceChanges: v.array(v.object({
        title: v.string(),
        oldPrice: v.number(),
        newPrice: v.number(),
        change: v.number(),
        changePercent: v.number(),
      })),
      summary: v.string(),
    })),
  })
    .index("by_monitorId", ["monitorId"])
    // Enables efficient time-ordered queries per monitor (e.g. "latest result for monitor X")
    .index("by_monitorId_scrapedAt", ["monitorId", "scrapedAt"]),

  notifications: defineTable({
    userId: v.string(),
    monitorId: v.id("monitors"),
    channel: v.union(
      v.literal("in_app"),
      v.literal("email"),
      v.literal("telegram"),
      v.literal("discord"),
      v.literal("push")
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
    // Scraping metadata
    retryAttempt: v.optional(v.number()),
    blocked: v.optional(v.boolean()),
    blockReason: v.optional(v.string()),
    strategy: v.optional(v.string()),
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
    .index("by_userId_channel", ["userId", "channel"])
    .index("by_channel_target", ["channel", "target"]),

  userTiers: defineTable({
    userId: v.string(),
    tier: v.union(v.literal("free"), v.literal("pro"), v.literal("max")),
    polarCustomerId: v.optional(v.string()),
    polarSubscriptionId: v.optional(v.string()),
    cancelledAt: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
    // Manual free-period grant (not a Polar subscription); expireGrants reverts it
    grantUntil: v.optional(v.number()),
    dailyScans: v.optional(v.number()),
    dailyScansDate: v.optional(v.string()),
    reviewDismissed: v.optional(v.boolean()),
    updatedAt: v.number(),
  }).index("by_userId", ["userId"]),

  // One row per device a user has granted push permission on. Unlike the other
  // channels there is no notificationSettings row: having a live subscription
  // is what "push is on" means, the same way email keys off userEmail.
  // Endpoints die silently, so a 404/410 from the push service deletes the row.
  pushSubscriptions: defineTable({
    userId: v.string(),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_endpoint", ["endpoint"]),

  channelClaims: defineTable({
    channel: v.union(v.literal("telegram"), v.literal("discord")),
    target: v.string(),
    userId: v.string(),
    claimedAt: v.number(),
  })
    .index("by_channel_target", ["channel", "target"])
    .index("by_userId", ["userId"]),

  reviews: defineTable({
    userId: v.string(),
    displayName: v.string(),
    role: v.optional(v.string()),
    quote: v.string(),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"]),

  anonymousScanCounter: defineTable({
    date: v.string(), // YYYY-MM-DD
    count: v.number(),
  }).index("by_date", ["date"]),

  // Lightweight counter for public monitor count (avoids reading all monitors)
  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),

  // Log of every monitor creation, kept even after the monitor is deleted —
  // powers the rolling creation-rate limit so delete-and-remake can't bypass it
  monitorCreations: defineTable({
    userId: v.string(),
    createdAt: v.number(),
  })
    .index("by_userId_createdAt", ["userId", "createdAt"]),

  // One row per email we hand to Resend. Without it a bounce and a delivery
  // look identical from inside the product: the sends are fire-and-forget and
  // the prod Resend key is send-only, so its API can't be asked either.
  // `status` starts at sent/failed and is advanced by the Resend webhook.
  emailSends: defineTable({
    to: v.string(),
    kind: v.string(), // match | error | monitor-stopped | price | anonymous-scan | onboarding-day0 | bulk
    userId: v.optional(v.string()),
    monitorId: v.optional(v.string()),
    resendId: v.optional(v.string()),
    status: v.union(
      v.literal("sent"),
      v.literal("failed"),
      v.literal("delivered"),
      v.literal("bounced"),
      v.literal("complained")
    ),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_resendId", ["resendId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_status_createdAt", ["status", "createdAt"]),

  // Audit log of bulk emails sent from the super-admin dashboard
  adminEmails: defineTable({
    sentBy: v.string(), // admin's email
    subject: v.string(),
    body: v.string(),
    recipients: v.array(v.string()),
    failedRecipients: v.array(v.string()),
    sentAt: v.number(),
  }).index("by_sentAt", ["sentAt"]),

  // Onboarding email scheduler — one row per (user, step). The four steps
  // are scheduled at signup time and processed by an hourly cron. See
  // PROWL-038 Phase 4. The day1/day3/day7 rows are queued from day one but
  // only the day0 send is wired up until Phase 7 — keeps the schema stable.
  onboardingEmails: defineTable({
    userId: v.string(),
    email: v.string(),
    step: v.union(
      v.literal("day0"),
      v.literal("day1"),
      v.literal("day3"),
      v.literal("day7"),
    ),
    scheduledFor: v.number(), // ms epoch
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    sentAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    // Step comes first so the processor can ask for one step's queue. Without
    // it, steps it doesn't send yet sit pending and crowd out the ones it does.
    .index("by_step_status_scheduledFor", ["step", "status", "scheduledFor"])
    .index("by_userId_step", ["userId", "step"]),
});
