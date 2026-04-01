import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { intervalToMs, MAX_RETRIES } from "./shared";

/** Filter out blacklisted items from a matches array based on item title/url keys */
function filterBlacklisted(matches: Record<string, unknown>[], blacklist: string[]): Record<string, unknown>[] {
  if (!blacklist || blacklist.length === 0) return matches;
  const blacklistSet = new Set(blacklist);
  return matches.filter((m) => {
    // Match the same key logic as getItemKey in @prowl/shared
    const url = m.url ? String(m.url) : null;
    const key = url ?? `${String(m.title ?? "")}-${String(m.price ?? "")}`;
    return !blacklistSet.has(key);
  });
}

// Inline change detection for Convex runtime
function detectChanges(previousItems: Record<string, unknown>[], currentItems: Record<string, unknown>[]) {
  const getTitle = (item: Record<string, unknown>) => String(item.title ?? item.name ?? "").toLowerCase();

  const prevByTitle = new Map(previousItems.map((i) => [getTitle(i), i]));
  const currByTitle = new Map(currentItems.map((i) => [getTitle(i), i]));

  const added = currentItems.filter((i) => !prevByTitle.has(getTitle(i)));
  const removed = previousItems.filter((i) => !currByTitle.has(getTitle(i)));

  const priceChanges: { title: string; oldPrice: number; newPrice: number; change: number; changePercent: number }[] = [];
  for (const [titleKey, currItem] of currByTitle) {
    const prevItem = prevByTitle.get(titleKey);
    if (!prevItem) continue;
    const cp = typeof currItem.price === "number" ? currItem.price : NaN;
    const pp = typeof prevItem.price === "number" ? prevItem.price : NaN;
    if (Number.isFinite(cp) && Number.isFinite(pp) && cp !== pp) {
      const change = cp - pp;
      priceChanges.push({
        title: String(currItem.title ?? ""),
        oldPrice: pp, newPrice: cp, change,
        changePercent: pp !== 0 ? Math.round((change / pp) * 1000) / 10 : 0,
      });
    }
  }

  const parts: string[] = [];
  if (added.length > 0) parts.push(`${added.length} new`);
  if (removed.length > 0) parts.push(`${removed.length} removed`);
  const drops = priceChanges.filter((p) => p.change < 0).length;
  const ups = priceChanges.filter((p) => p.change > 0).length;
  if (drops > 0) parts.push(`${drops} price drop${drops !== 1 ? "s" : ""}`);
  if (ups > 0) parts.push(`${ups} price increase${ups !== 1 ? "s" : ""}`);

  return { added, removed, priceChanges, summary: parts.length > 0 ? parts.join(", ") : "No changes" };
}

const MAX_CONCURRENT_CHECKS = 5;
const FULL_REEXTRACT_EVERY = 100;

/** Query monitors that are due for a check */
export const getMonitorsDue = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Use the nextCheckAt index to efficiently find due monitors
    const due = await ctx.db
      .query("monitors")
      .withIndex("by_nextCheckAt")
      .collect();

    return due
      .filter((m) => m.status === "active" && m.nextCheckAt != null && m.nextCheckAt <= now)
      .slice(0, MAX_CONCURRENT_CHECKS);
  },
});

/** Record the result of a scheduled check */
export const recordCheckResult = internalMutation({
  args: {
    monitorId: v.id("monitors"),
    hasNewMatches: v.boolean(),
    matchCount: v.number(),
    totalItems: v.number(),
    matches: v.array(v.any()),
    items: v.optional(v.array(v.any())),
    schema: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor || monitor.status !== "active") return;

    const now = Date.now();

    if (args.error) {
      const retryCount = (monitor.retryCount ?? 0) + 1;
      if (retryCount >= MAX_RETRIES) {
        await ctx.db.patch(args.monitorId, {
          status: "error",
          lastError: args.error,
          retryCount,
          nextCheckAt: undefined,
          updatedAt: now,
        });
      } else {
        const backoffMs = Math.pow(4, retryCount) * 30_000;
        await ctx.db.patch(args.monitorId, {
          lastError: args.error,
          retryCount,
          nextCheckAt: now + backoffMs,
          updatedAt: now,
        });
      }
      return;
    }

    // Success
    const updates: Record<string, unknown> = {
      status: "active",
      matchCount: args.matchCount,
      checkCount: (monitor.checkCount ?? 0) + 1,
      retryCount: 0,
      lastCheckedAt: now,
      nextCheckAt: now + intervalToMs(monitor.checkInterval),
      updatedAt: now,
      lastError: undefined,
    };

    if (args.matchCount > 0) {
      updates.lastMatchAt = now;
    }

    if (args.schema) {
      updates.schema = args.schema;
    }

    await ctx.db.patch(args.monitorId, updates);

    // Compute changes from the previous scrape result
    let changes;
    if (args.items && args.items.length > 0) {
      const prevResult = await ctx.db
        .query("scrapeResults")
        .withIndex("by_monitorId_scrapedAt", (q) => q.eq("monitorId", args.monitorId))
        .order("desc")
        .first();

      if (prevResult?.items && Array.isArray(prevResult.items)) {
        changes = detectChanges(
          prevResult.items as Record<string, unknown>[],
          args.items as Record<string, unknown>[]
        );
      }
    }

    await ctx.db.insert("scrapeResults", {
      monitorId: args.monitorId,
      matches: args.matches,
      items: args.items,
      totalItems: args.totalItems,
      hasNewMatches: args.hasNewMatches,
      scrapedAt: now,
      changes,
    });
  },
});

/** The main scheduler action — called by cron */
export const runScheduledChecks = internalAction({
  args: {},
  handler: async (ctx) => {
    const scraperUrl = process.env.SCRAPER_URL;
    const scraperKey = process.env.SCRAPER_API_KEY;

    if (!scraperUrl || !scraperKey) {
      console.error("[scheduler] SCRAPER_URL or SCRAPER_API_KEY not configured");
      return;
    }

    const monitors = await ctx.runQuery(internal.scheduler.getMonitorsDue);
    if (monitors.length === 0) return;

    console.log(`[scheduler] ${monitors.length} monitor(s) due for check`);

    // Run checks concurrently (up to MAX_CONCURRENT_CHECKS)
    const results = await Promise.allSettled(
      monitors.map(async (monitor) => {
        try {
          const checkCount = monitor.checkCount ?? 0;
          const needsReextract = checkCount > 0 && checkCount % FULL_REEXTRACT_EVERY === 0;

          let checkResult: { hasMatch: boolean; matchCount: number; matches: unknown[]; totalItems: number };

          if (needsReextract && monitor.schema) {
            checkResult = await runFullExtract(ctx, monitor, scraperUrl, scraperKey);
          } else {
            checkResult = await runQuickCheck(ctx, monitor, scraperUrl, scraperKey);
          }

          // Only notify on NEW matches (not when the same match persists across checks)
          const previouslyHadMatches = (monitor.matchCount ?? 0) > 0;
          const isNewMatch = checkResult.hasMatch && !previouslyHadMatches;

          if (isNewMatch) {
            // Per-monitor channel filtering: if set, only send to those channels
            const monitorChannels = (monitor as any).notificationChannels as string[] | undefined;
            const shouldSend = (channel: string) => !monitorChannels || monitorChannels.includes(channel);

            // Create in-app notification (always)
            await ctx.runMutation(internal.userNotifications.create, {
              userId: monitor.userId,
              monitorId: monitor._id,
              channel: "in_app",
              title: `${monitor.name} — ${checkResult.matchCount} match${checkResult.matchCount !== 1 ? "es" : ""}`,
              message: `Found ${checkResult.matchCount} match${checkResult.matchCount !== 1 ? "es" : ""} out of ${checkResult.totalItems} items on ${monitor.url}`,
            }).catch(() => {});

            // Send email
            if (shouldSend("email") && monitor.userEmail) {
              await ctx.runAction(internal.emails.sendMatchAlert, {
                to: monitor.userEmail,
                monitorName: monitor.name,
                monitorId: monitor._id,
                url: monitor.url,
                matchCount: checkResult.matchCount,
                matches: checkResult.matches,
                totalItems: checkResult.totalItems,
              }).catch(() => {});
            }

            // Send to Telegram if configured and enabled for this monitor
            if (shouldSend("telegram")) {
              const telegramSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
                userId: monitor.userId,
                channel: "telegram",
              });
              if (telegramSetting?.enabled && telegramSetting.target) {
                await ctx.runAction(internal.telegram.sendMatchAlert, {
                  chatId: telegramSetting.target,
                  monitorName: monitor.name,
                  monitorId: monitor._id,
                  url: monitor.url,
                  matchCount: checkResult.matchCount,
                  totalItems: checkResult.totalItems,
                }).catch(() => {});
              }
            }

            // Send to Discord if configured and enabled for this monitor
            if (shouldSend("discord")) {
              const discordSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
                userId: monitor.userId,
                channel: "discord",
              });
              if (discordSetting?.enabled && discordSetting.target) {
                await ctx.runAction(internal.discord.sendMatchAlert, {
                  webhookUrl: discordSetting.target,
                  monitorName: monitor.name,
                  monitorId: monitor._id,
                  url: monitor.url,
                  matchCount: checkResult.matchCount,
                  totalItems: checkResult.totalItems,
                }).catch(() => {});
              }
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          console.error(`[scheduler] Monitor ${monitor._id} failed:`, msg);

          // Check if this will max out retries
          const retryCount = (monitor.retryCount ?? 0) + 1;
          const willError = retryCount >= MAX_RETRIES;

          await ctx.runMutation(internal.scheduler.recordCheckResult, {
            monitorId: monitor._id,
            hasNewMatches: false,
            matchCount: 0,
            totalItems: 0,
            matches: [],
            error: msg,
          });

          // Send error notifications when retries exhausted
          if (willError) {
            const monitorChannels = (monitor as any).notificationChannels as string[] | undefined;
            const shouldSend = (channel: string) => !monitorChannels || monitorChannels.includes(channel);

            // In-app notification (always)
            await ctx.runMutation(internal.userNotifications.create, {
              userId: monitor.userId,
              monitorId: monitor._id,
              channel: "in_app",
              title: `${monitor.name} — Error`,
              message: msg,
            }).catch(() => {});

            // Email
            if (shouldSend("email") && monitor.userEmail) {
              await ctx.runAction(internal.emails.sendErrorAlert, {
                to: monitor.userEmail,
                monitorName: monitor.name,
                monitorId: monitor._id,
                url: monitor.url,
                error: msg,
              }).catch(() => {});
            }

            // Telegram
            if (shouldSend("telegram")) {
              const telegramSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
                userId: monitor.userId,
                channel: "telegram",
              });
              if (telegramSetting?.enabled && telegramSetting.target) {
                await ctx.runAction(internal.telegram.sendErrorAlert, {
                  chatId: telegramSetting.target,
                  monitorName: monitor.name,
                  monitorId: monitor._id,
                  url: monitor.url,
                  error: msg,
                }).catch(() => {});
              }
            }

            // Discord
            if (shouldSend("discord")) {
              const discordSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
                userId: monitor.userId,
                channel: "discord",
              });
              if (discordSetting?.enabled && discordSetting.target) {
                await ctx.runAction(internal.discord.sendErrorAlert, {
                  webhookUrl: discordSetting.target,
                  monitorName: monitor.name,
                  monitorId: monitor._id,
                  url: monitor.url,
                error: msg,
              }).catch(() => {});
            }
          }
        }
      })
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      console.log(`[scheduler] Done: ${succeeded} ok, ${failed} failed`);
    }
  },
});

async function runQuickCheck(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monitor: any,
  scraperUrl: string,
  scraperKey: string
): Promise<{ hasMatch: boolean; matchCount: number; matches: unknown[]; totalItems: number }> {
  const matchConditions = monitor.schema?.matchConditions ?? {};

  const res = await fetch(`${scraperUrl}/api/quick-check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": scraperKey,
    },
    body: JSON.stringify({
      url: monitor.url,
      matchConditions,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Scraper returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const result = await res.json();

  if (!result.accessible) {
    throw new Error("Page inaccessible");
  }

  const hasMatch = result.hasNewMatches;

  await ctx.runMutation(internal.scheduler.recordCheckResult, {
    monitorId: monitor._id,
    hasNewMatches: hasMatch,
    matchCount: hasMatch ? (monitor.matchCount ?? 0) + 1 : 0,
    totalItems: 0,
    matches: hasMatch
      ? [{ quickCheck: true, keywordResults: result.keywordResults, priceResults: result.priceResults }]
      : [],
  });

  console.log(`[scheduler] Quick check ${monitor._id}: ${hasMatch ? "MATCH" : "no match"}`);

  const matchData = hasMatch
    ? [{ quickCheck: true, keywordResults: result.keywordResults, priceResults: result.priceResults }]
    : [];
  return { hasMatch, matchCount: hasMatch ? 1 : 0, matches: matchData, totalItems: 0 };
}

async function runFullExtract(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monitor: any,
  scraperUrl: string,
  scraperKey: string
): Promise<{ hasMatch: boolean; matchCount: number; matches: unknown[]; totalItems: number }> {
  // First check page is accessible before burning AI credits
  const quickRes = await fetch(`${scraperUrl}/api/quick-check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": scraperKey,
    },
    body: JSON.stringify({
      url: monitor.url,
      matchConditions: monitor.schema?.matchConditions ?? {},
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (quickRes.ok) {
    const quickResult = await quickRes.json();
    if (!quickResult.accessible) {
      // Soft failure — don't count as retry, just skip the re-extract
      console.log(`[scheduler] Skipping re-extract for ${monitor._id}: page inaccessible`);
      await ctx.runMutation(internal.scheduler.recordCheckResult, {
        monitorId: monitor._id,
        hasNewMatches: false,
        matchCount: monitor.matchCount ?? 0,
        totalItems: 0,
        matches: [],
        // No error field — this is informational, not a retry-worthy failure
      });
      return { hasMatch: false, matchCount: 0, matches: [], totalItems: 0 };
    }
  }

  // Page is accessible — do the full AI extraction
  const res = await fetch(`${scraperUrl}/api/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": scraperKey,
    },
    body: JSON.stringify({
      url: monitor.url,
      prompt: monitor.prompt,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI extract failed ${res.status}: ${body.slice(0, 200)}`);
  }

  const result = await res.json();

  // If low confidence + no items, keep existing schema
  const confidence = result.schema?.insights?.confidence ?? 100;
  if (confidence <= 10 && (result.totalItems ?? 0) === 0) {
    // Soft failure — don't count as retry
    console.log(`[scheduler] Re-extract ${monitor._id}: low confidence (${confidence}%), keeping existing schema`);
    await ctx.runMutation(internal.scheduler.recordCheckResult, {
      monitorId: monitor._id,
      hasNewMatches: false,
      matchCount: monitor.matchCount ?? 0,
      totalItems: 0,
      matches: [],
      // No error field — informational, not retry-worthy
    });
    return { hasMatch: false, matchCount: 0, matches: [], totalItems: 0 };
  }

  const allMatches = result.matches ?? [];
  const totalItems = result.totalItems ?? 0;

  // Filter out blacklisted items so they don't count as matches or trigger emails
  const blacklist = monitor.blacklistedItems ?? [];
  const filteredMatches = filterBlacklisted(allMatches as Record<string, unknown>[], blacklist);
  const matchCount = filteredMatches.length;

  await ctx.runMutation(internal.scheduler.recordCheckResult, {
    monitorId: monitor._id,
    hasNewMatches: matchCount > 0,
    matchCount,
    totalItems,
    matches: filteredMatches,
    items: result.schema?.items ?? [],
    schema: result.schema,
  });

  console.log(`[scheduler] Full re-extract ${monitor._id}: ${totalItems} items, ${matchCount} matches (${allMatches.length - matchCount} blacklisted)`);

  return { hasMatch: matchCount > 0, matchCount, matches: filteredMatches, totalItems };
}

/** Internal query to get a user's notification setting for a specific channel */
export const getNotificationSetting = internalQuery({
  args: {
    userId: v.string(),
    channel: v.union(v.literal("email"), v.literal("telegram"), v.literal("discord")),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("notificationSettings")
      .withIndex("by_userId_channel", (q) =>
        q.eq("userId", args.userId).eq("channel", args.channel)
      )
      .unique();
  },
});
