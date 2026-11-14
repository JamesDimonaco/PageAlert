import { v } from "convex/values";
import { mutation, query, internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { isBanned, isLiveAccount } from "./account";

const EXPIRY_WITH_EMAIL = 30 * 24 * 60 * 60 * 1000; // 30 days

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
    // A banned account shouldn't gain a freshly-scanning monitor via the claim flow
    if (await isBanned(ctx, identity.subject)) return { transferred: 0 };
    // Nor a deleted one: the monitor would scan and email with no login able
    // to reach it. Silent because the layout fires this on every load.
    if (!(await isLiveAccount(ctx, identity.subject))) return { transferred: 0 };

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
