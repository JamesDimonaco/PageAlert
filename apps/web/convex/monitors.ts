import { v } from "convex/values";
import { mutation, query, internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { intervalToMs, MAX_RETRIES, validateMonitorUrl } from "./shared";

// ---- Resource Limits ----
const MAX_NAME_LENGTH = 200;
const MAX_PROMPT_LENGTH = 2000;
const MAX_RESULTS_LIMIT = 100;

type Tier = "free" | "pro" | "max";

const TIER_LIMITS: Record<Tier, { maxMonitors: number; allowedIntervals: string[] }> = {
  free: { maxMonitors: 3, allowedIntervals: ["6h", "24h"] },
  pro: { maxMonitors: 25, allowedIntervals: ["15m", "30m", "1h", "6h", "24h"] },
  max: { maxMonitors: 9999, allowedIntervals: ["5m", "15m", "30m", "1h", "6h", "24h"] },
};

async function getUserTier(ctx: { db: any }, userId: string): Promise<Tier> {
  const record = await ctx.db
    .query("userTiers")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .unique();
  return (record?.tier as Tier) ?? "free";
}

type CheckInterval = "5m" | "15m" | "30m" | "1h" | "6h" | "24h";

function clampInterval(interval: string, tier: Tier): CheckInterval {
  const allowed = TIER_LIMITS[tier].allowedIntervals;
  return (allowed.includes(interval) ? interval : allowed[0]) as CheckInterval;
}

async function getAuthUserId(ctx: { auth: { getUserIdentity: () => Promise<{ subject: string } | null> } }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity.subject;
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
  v.literal("error")
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

/** Public: total non-anonymous monitors for social proof.
 * Reads a single counter document instead of scanning all monitors.
 */
export const publicCount = query({
  args: {},
  handler: async (ctx) => {
    const counter = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", "monitors"))
      .unique();
    return counter?.value ?? 0;
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const monitors = await ctx.db
      .query("monitors")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .collect();
    // Strip heavy schema field — dashboard only needs metadata, not full extraction data.
    // The detail page uses the `get` query which returns the full document.
    return monitors.map(({ schema, ...rest }) => rest);
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

const channelValidator = v.array(v.union(
  v.literal("email"),
  v.literal("telegram"),
  v.literal("discord")
));

/** Create a monitor in "scanning" state. The scan runs client-side, then saveScanResult is called. */
export const create = mutation({
  args: {
    name: v.string(),
    url: v.string(),
    prompt: v.string(),
    checkInterval: intervalValidator,
    notificationChannels: v.optional(channelValidator),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = identity.subject;
    const userEmail = identity.email ?? undefined;

    // Dynamic tier-based enforcement
    const tier = await getUserTier(ctx, userId);
    const limits = TIER_LIMITS[tier];
    const checkInterval = clampInterval(args.checkInterval, tier);

    validateName(args.name);
    validateMonitorUrl(args.url);
    validatePrompt(args.prompt);

    const existingMonitors = await ctx.db
      .query("monitors")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    if (existingMonitors.length >= limits.maxMonitors) {
      throw new Error(`Your ${tier} plan allows ${limits.maxMonitors} monitors. Upgrade for more.`);
    }

    // Server-side enforcement: free tier can only have one monitor with non-email channels
    let channels = args.notificationChannels;
    if (tier === "free" && channels) {
      const hasNonEmail = channels.some((c) => c !== "email");
      if (hasNonEmail) {
        const existingWithChannels = existingMonitors.find((m) =>
          (m as any).notificationChannels?.some((c: string) => c === "telegram" || c === "discord")
        );
        if (existingWithChannels) {
          // Strip non-email channels — free user already has one monitor with them
          channels = channels.filter((c) => c === "email");
        }
      }
    }

    const now = Date.now();
    const id = await ctx.db.insert("monitors", {
      name: args.name.trim(),
      url: args.url.trim(),
      prompt: args.prompt.trim(),
      checkInterval: checkInterval,
      notificationChannels: channels,
      userId,
      userEmail,
      status: "scanning",
      matchCount: 0,
      checkCount: 0,
      retryCount: 0,
      nextCheckAt: now + intervalToMs(checkInterval),
      createdAt: now,
      updatedAt: now,
    });

    // Increment public monitor counter (lightweight alternative to counting all docs)
    const counter = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "monitors")).unique();
    if (counter) {
      await ctx.db.patch(counter._id, { value: counter.value + 1 });
    } else {
      // First time — seed counter from existing non-anonymous monitors + this new one
      const existing = await ctx.db.query("monitors").collect();
      const currentCount = existing.filter((m) => !m.isAnonymous).length;
      await ctx.db.insert("counters", { name: "monitors", value: currentCount });
    }

    return id;
  },
});

/** Save scan results to a monitor. Transitions from "scanning" to "active". */
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

    // Save initial scan to history so it appears in the History tab
    const items = Array.isArray(schema?.items) ? schema.items : [];
    await ctx.db.insert("scrapeResults", {
      monitorId: id,
      matches: items.slice(0, 50),
      totalItems: items.length,
      hasNewMatches: matchCount > 0,
      scrapedAt: now,
    });

    // Send notifications for initial scan matches
    if (matchCount > 0) {
      await ctx.scheduler.runAfter(0, internal.monitors.sendInitialScanNotifications, {
        monitorId: id,
        matchCount,
        totalItems: items.length,
      });
    }
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

    if (monitor.status !== "scanning" && monitor.status !== "active") return;

    const isBlocked = error.includes("blocking") || error.includes("anti-bot") || error.includes("CAPTCHA") || error.includes("blocked");
    const now = Date.now();

    if (isBlocked && monitor.status === "scanning") {
      // Blocked on initial scan — schedule retries with proxy instead of instant death.
      // Start at retryCount 1 so the scheduler uses proxy on the first retry
      // (retryCount 0 = no proxy = would fail the same way)
      await ctx.db.patch(id, {
        status: "active",
        lastError: error,
        retryCount: 1,
        nextCheckAt: now + 30_000, // first retry in 30s
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(id, {
        status: "error",
        lastError: error,
        retryCount: 0,
        nextCheckAt: undefined,
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
    notificationChannels: v.optional(channelValidator),
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
  },
  handler: async (ctx, { id, ...fields }) => {
    const userId = await getAuthUserId(ctx);
    const existing = await ctx.db.get(id);
    if (!existing || existing.userId !== userId) throw new Error("Monitor not found");

    if (fields.name !== undefined) validateName(fields.name);
    if (fields.url !== undefined) validateMonitorUrl(fields.url);
    if (fields.prompt !== undefined) validatePrompt(fields.prompt);

    // Dynamic tier-based enforcement
    const tier = (fields.checkInterval !== undefined || fields.notificationChannels !== undefined)
      ? await getUserTier(ctx, userId)
      : null;

    if (fields.checkInterval !== undefined && tier) {
      fields.checkInterval = clampInterval(fields.checkInterval, tier) as typeof fields.checkInterval;
    }

    // Free tier: only one monitor can have non-email channels
    if (fields.notificationChannels !== undefined && tier === "free") {
      const hasNonEmail = fields.notificationChannels.some((c) => c !== "email");
      if (hasNonEmail) {
        const otherMonitors = await ctx.db
          .query("monitors")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .collect();
        const otherWithChannels = otherMonitors.find((m) =>
          m._id !== id &&
          (m as any).notificationChannels?.some((c: string) => c === "telegram" || c === "discord")
        );
        if (otherWithChannels) {
          fields.notificationChannels = fields.notificationChannels.filter((c) => c === "email") as typeof fields.notificationChannels;
        }
      }
    }

    // Validate priceAlerts if provided
    if (fields.priceAlerts !== undefined) {
      const pa = fields.priceAlerts;
      if (pa.belowThreshold !== undefined && pa.belowThreshold <= 0) {
        throw new Error("Below threshold must be a positive number");
      }
      if (pa.aboveThreshold !== undefined && pa.aboveThreshold <= 0) {
        throw new Error("Above threshold must be a positive number");
      }
      if (pa.trackedItems.length > 20) {
        throw new Error("Cannot track more than 20 items");
      }
      if (pa.minChangePercent !== undefined && (pa.minChangePercent < 0 || pa.minChangePercent > 50)) {
        throw new Error("Min change percent must be between 0 and 50");
      }
      if (pa.cooldownMs !== undefined && (pa.cooldownMs < 0 || pa.cooldownMs > 7 * 24 * 60 * 60 * 1000)) {
        throw new Error("Cooldown must be between 0 and 7 days");
      }
    }

    const now = Date.now();
    const updates: Record<string, unknown> = { updatedAt: now };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        updates[key] = typeof value === "string" ? value.trim() : value;
      }
    }

    // Recompute nextCheckAt when interval changes so it takes effect immediately
    if (fields.checkInterval !== undefined) {
      updates.nextCheckAt = now + intervalToMs(fields.checkInterval);
    }

    await ctx.db.patch(id, updates);
    return id;
  },
});

export const toggleMute = mutation({
  args: { id: v.id("monitors") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    const monitor = await ctx.db.get(id);
    if (!monitor || monitor.userId !== userId) throw new Error("Monitor not found");
    const newMuted = !monitor.muted;
    await ctx.db.patch(id, { muted: newMuted, updatedAt: Date.now() });
    return newMuted;
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

    // Decrement public monitor counter
    if (!existing.isAnonymous) {
      const counter = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "monitors")).unique();
      if (counter && counter.value > 0) {
        await ctx.db.patch(counter._id, { value: counter.value - 1 });
      }
    }
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

/** Internal: get a monitor by ID without auth check (for internal actions) */
export const getInternal = internalQuery({
  args: { id: v.id("monitors") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

/** Send notifications for the initial scan when matches are found */
export const sendInitialScanNotifications = internalAction({
  args: {
    monitorId: v.id("monitors"),
    matchCount: v.number(),
    totalItems: v.number(),
  },
  handler: async (ctx, args) => {
    const monitor = await ctx.runQuery(internal.monitors.getInternal, { id: args.monitorId });
    if (!monitor) return;
    if (monitor.muted) return; // Muted — skip all notifications

    const monitorChannels = (monitor as any).notificationChannels as string[] | undefined;
    const shouldSend = (channel: string) => !monitorChannels || monitorChannels.includes(channel);
    const hasAnyChannel = !monitorChannels || monitorChannels.length > 0;

    // In-app notification
    if (hasAnyChannel) {
      await ctx.runMutation(internal.userNotifications.create, {
        userId: monitor.userId,
        monitorId: args.monitorId,
        channel: "in_app",
        title: `${monitor.name} — ${args.matchCount} match${args.matchCount !== 1 ? "es" : ""} found`,
        message: `Initial scan found ${args.matchCount} match${args.matchCount !== 1 ? "es" : ""} out of ${args.totalItems} items on ${monitor.url}`,
      }).catch((e) => console.error("[monitors] Notification failed:", e));
    }

    // Email
    if (shouldSend("email") && monitor.userEmail) {
      await ctx.runAction(internal.emails.sendMatchAlert, {
        to: monitor.userEmail,
        monitorName: monitor.name,
        monitorId: args.monitorId,
        url: monitor.url,
        matchCount: args.matchCount,
        matches: [],
        totalItems: args.totalItems,
        tracksPrices: !!(monitor.schema as any)?.insights?.tracksPrices,
      }).catch((e) => console.error("[monitors] Notification failed:", e));
    }

    // Telegram
    if (shouldSend("telegram")) {
      const telegramSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
        userId: monitor.userId,
        channel: "telegram",
      });
      if (telegramSetting?.enabled && telegramSetting.target) {
        await ctx.runAction(internal.telegram.sendMatchAlert, {
          chatId: telegramSetting.target,
          monitorName: monitor.name,
          monitorId: args.monitorId,
          url: monitor.url,
          matchCount: args.matchCount,
          totalItems: args.totalItems,
        }).catch((e) => console.error("[monitors] Notification failed:", e));
      }
    }

    // Discord
    if (shouldSend("discord")) {
      const discordSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
        userId: monitor.userId,
        channel: "discord",
      });
      if (discordSetting?.enabled && discordSetting.target) {
        await ctx.runAction(internal.discord.sendMatchAlert, {
          webhookUrl: discordSetting.target,
          monitorName: monitor.name,
          monitorId: args.monitorId,
          url: monitor.url,
          matchCount: args.matchCount,
          totalItems: args.totalItems,
        }).catch((e) => console.error("[monitors] Notification failed:", e));
      }
    }
  },
});
