import { v } from "convex/values";
import { mutation, query, internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { validateMonitorUrl } from "./shared";

const DAILY_CAP = 20;
const EXPIRY_NO_EMAIL = 7 * 24 * 60 * 60 * 1000; // 7 days
const EXPIRY_WITH_EMAIL = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Check if the daily anonymous scan cap has been reached */
export const canScan = query({
  args: {},
  handler: async (ctx) => {
    const today = new Date().toISOString().split("T")[0]!;
    const counter = await ctx.db
      .query("anonymousScanCounter")
      .withIndex("by_date", (q) => q.eq("date", today))
      .unique();
    return { canScan: (counter?.count ?? 0) < DAILY_CAP, remaining: DAILY_CAP - (counter?.count ?? 0) };
  },
});

/** Create an anonymous monitor (no auth required) */
export const createAnonymous = mutation({
  args: {
    name: v.string(),
    url: v.string(),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    // Check daily cap
    const today = new Date().toISOString().split("T")[0]!;
    const counter = await ctx.db
      .query("anonymousScanCounter")
      .withIndex("by_date", (q) => q.eq("date", today))
      .unique();

    if ((counter?.count ?? 0) >= DAILY_CAP) {
      throw new Error("We've reached the daily limit for free scans. Create a free account to scan now!");
    }

    // Validate URL with SSRF protection (before incrementing counter)
    validateMonitorUrl(args.url);

    const now = Date.now();
    const anonId = `anon_${crypto.randomUUID()}`;

    const monitorId = await ctx.db.insert("monitors", {
      userId: anonId,
      name: args.name.trim().slice(0, 200),
      url: args.url.trim(),
      prompt: args.prompt.trim().slice(0, 2000),
      checkInterval: "24h",
      status: "scanning",
      matchCount: 0,
      checkCount: 0,
      retryCount: 0,
      isAnonymous: true,
      expiresAt: now + EXPIRY_NO_EMAIL,
      createdAt: now,
      updatedAt: now,
    });

    // Increment counter only after successful monitor creation
    if (counter) {
      await ctx.db.patch(counter._id, { count: counter.count + 1 });
    } else {
      await ctx.db.insert("anonymousScanCounter", { date: today, count: 1 });
    }

    return { monitorId, anonId };
  },
});

/** Save scan results for an anonymous monitor */
export const saveAnonymousResult = mutation({
  args: {
    monitorId: v.id("monitors"),
    anonId: v.string(),
    schema: v.any(),
    matchCount: v.number(),
  },
  handler: async (ctx, args) => {
    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor || monitor.userId !== args.anonId || !monitor.isAnonymous) {
      throw new Error("Monitor not found");
    }
    if (monitor.status !== "scanning") return;

    const now = Date.now();
    await ctx.db.patch(args.monitorId, {
      schema: args.schema,
      status: "active",
      matchCount: args.matchCount,
      checkCount: 1,
      lastCheckedAt: now,
      lastMatchAt: args.matchCount > 0 ? now : undefined,
      // No nextCheckAt — anonymous monitors without email don't get scheduled checks
      updatedAt: now,
    });

    // Save to history
    const items = Array.isArray(args.schema?.items) ? args.schema.items : [];
    await ctx.db.insert("scrapeResults", {
      monitorId: args.monitorId,
      matches: items.slice(0, 50),
      totalItems: items.length,
      hasNewMatches: args.matchCount > 0,
      scrapedAt: now,
    });
  },
});

/** Save error for an anonymous scan */
export const saveAnonymousError = mutation({
  args: {
    monitorId: v.id("monitors"),
    anonId: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor || monitor.userId !== args.anonId || !monitor.isAnonymous) return;

    await ctx.db.patch(args.monitorId, {
      status: "error",
      lastError: args.error,
      updatedAt: Date.now(),
    });
  },
});

/** Get an anonymous monitor by ID (public — no auth) */
export const getAnonymous = query({
  args: { monitorId: v.id("monitors") },
  handler: async (ctx, args) => {
    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor || !monitor.isAnonymous) return null;

    // Check expiry
    if (monitor.expiresAt && monitor.expiresAt < Date.now()) return null;

    return {
      _id: monitor._id,
      name: monitor.name,
      url: monitor.url,
      prompt: monitor.prompt,
      status: monitor.status,
      matchCount: monitor.matchCount,
      lastError: monitor.lastError,
      schema: monitor.schema,
      hasClaimed: !!monitor.anonymousEmail,
      createdAt: monitor.createdAt,
      expiresAt: monitor.expiresAt,
    };
  },
});

/** Claim an anonymous monitor with an email */
export const claimWithEmail = mutation({
  args: {
    monitorId: v.id("monitors"),
    anonId: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor || monitor.userId !== args.anonId || !monitor.isAnonymous) {
      throw new Error("Monitor not found");
    }

    // Basic email validation
    if (!args.email.includes("@") || args.email.length < 5) {
      throw new Error("Invalid email");
    }

    const now = Date.now();
    await ctx.db.patch(args.monitorId, {
      anonymousEmail: args.email.trim().toLowerCase(),
      userEmail: args.email.trim().toLowerCase(),
      expiresAt: now + EXPIRY_WITH_EMAIL,
      // Enable scheduled checks now that they've given email
      nextCheckAt: now + 24 * 60 * 60 * 1000, // 24h from now
      updatedAt: now,
    });

    // Schedule email notification about results
    await ctx.scheduler.runAfter(0, internal.emails.sendAnonymousScanComplete, {
      to: args.email.trim().toLowerCase(),
      monitorName: monitor.name,
      monitorId: args.monitorId,
      url: monitor.url,
      matchCount: monitor.matchCount,
      totalItems: Array.isArray((monitor.schema as any)?.items) ? (monitor.schema as any).items.length : 0,
    });

    return { claimed: true };
  },
});

/** Transfer anonymous monitors to a real user account (called after signup) */
export const transferToUser = internalMutation({
  args: {
    email: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const monitors = await ctx.db
      .query("monitors")
      .withIndex("by_anonymousEmail", (q) => q.eq("anonymousEmail", args.email.toLowerCase()))
      .collect();

    let transferred = 0;
    for (const monitor of monitors) {
      if (monitor.isAnonymous) {
        await ctx.db.patch(monitor._id, {
          userId: args.userId,
          userEmail: args.email.toLowerCase(),
          isAnonymous: undefined,
          expiresAt: undefined,
          anonymousEmail: undefined,
          updatedAt: Date.now(),
        });
        transferred++;
      }
    }

    return { transferred };
  },
});

/** Public: transfer anonymous monitors to the authenticated user.
 *  Finds by email match OR by specific monitorId from localStorage. */
export const claimMyAnonymousMonitors = mutation({
  args: {
    monitorId: v.optional(v.id("monitors")),
    anonId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { transferred: 0 };

    const toTransfer: Array<{ _id: any }> = [];

    // Find by email match
    if (identity.email) {
      const byEmail = await ctx.db
        .query("monitors")
        .withIndex("by_anonymousEmail", (q) => q.eq("anonymousEmail", identity.email!.toLowerCase()))
        .collect();
      for (const m of byEmail) {
        if (m.isAnonymous) toTransfer.push(m);
      }
    }

    // Find by localStorage monitorId + anonId
    if (args.monitorId && args.anonId) {
      const byId = await ctx.db.get(args.monitorId);
      if (byId && byId.isAnonymous && byId.userId === args.anonId) {
        if (!toTransfer.some((m) => m._id === byId._id)) {
          toTransfer.push(byId);
        }
      }
    }

    let transferred = 0;
    for (const monitor of toTransfer) {
      await ctx.db.patch(monitor._id, {
        userId: identity.subject,
        userEmail: identity.email?.toLowerCase(),
        isAnonymous: undefined,
        expiresAt: undefined,
        anonymousEmail: undefined,
        updatedAt: Date.now(),
      });
      transferred++;
    }

    return { transferred };
  },
});

/** Cleanup expired anonymous monitors — called by cron daily */
export const cleanupExpired = internalAction({
  handler: async (ctx) => {
    const result = await ctx.runMutation(internal.anonymous.deleteExpiredMonitors);
    if (result.deleted > 0) {
      console.log(`[anonymous] Cleaned up ${result.deleted} expired anonymous monitors`);
    }
  },
});

/** Delete expired anonymous monitors and their data */
export const deleteExpiredMonitors = internalMutation({
  handler: async (ctx) => {
    const now = Date.now();

    // Find expired anonymous monitors using compound index
    const expired = await ctx.db
      .query("monitors")
      .withIndex("by_isAnonymous_expiresAt", (q) =>
        q.eq("isAnonymous", true).lt("expiresAt", now)
      )
      .collect();

    let deleted = 0;
    for (const monitor of expired) {
      // Delete scrape results
      const results = await ctx.db
        .query("scrapeResults")
        .withIndex("by_monitorId", (q) => q.eq("monitorId", monitor._id))
        .collect();
      for (const result of results) {
        await ctx.db.delete(result._id);
      }

      // Delete notifications
      const notifs = await ctx.db
        .query("notifications")
        .withIndex("by_monitorId", (q) => q.eq("monitorId", monitor._id))
        .collect();
      for (const notif of notifs) {
        await ctx.db.delete(notif._id);
      }

      // Delete the monitor
      await ctx.db.delete(monitor._id);
      deleted++;
    }

    // Also clean up old daily counters (older than 7 days)
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;
    const counters = await ctx.db.query("anonymousScanCounter").collect();
    for (const counter of counters) {
      if (counter.date < weekAgo) {
        await ctx.db.delete(counter._id);
      }
    }

    return { deleted };
  },
});
