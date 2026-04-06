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
        const startTime = Date.now();
        try {
          const checkCount = monitor.checkCount ?? 0;
          const needsReextract = checkCount > 0 && checkCount % FULL_REEXTRACT_EVERY === 0;

          let checkResult: { hasMatch: boolean; matchCount: number; matches: unknown[]; totalItems: number | null };

          if (needsReextract && monitor.schema) {
            checkResult = await runFullExtract(ctx, monitor, scraperUrl, scraperKey);
          } else {
            checkResult = await runQuickCheck(ctx, monitor, scraperUrl, scraperKey);
          }

          // Log successful check — use monitor's last known item count when totalItems is unknown
          const displayTotalItems = checkResult.totalItems != null
            ? checkResult.totalItems
            : (Array.isArray((monitor.schema as any)?.items) ? (monitor.schema as any).items.length : 0);
          await ctx.runMutation(internal.logs.createInternal, {
            userId: monitor.userId,
            monitorId: monitor._id,
            monitorName: monitor.name,
            url: monitor.url,
            prompt: monitor.prompt,
            status: "success",
            durationMs: Date.now() - startTime,
            itemCount: displayTotalItems,
            matchCount: checkResult.matchCount,
          }).catch(() => {});

          // Re-fetch monitor to pick up any user changes (muted, channels) during the long-running check
          const freshMonitor = await ctx.runQuery(internal.monitors.getInternal, { id: monitor._id });
          if (!freshMonitor || freshMonitor.muted) {
            if (!freshMonitor) console.log(`[scheduler] Monitor ${monitor._id} deleted during check, skipping notifications`);
            // Data already recorded above — just skip notifications
          } else {
            // Only notify on NEW matches (not when the same match persists across checks)
            const previouslyHadMatches = (monitor.matchCount ?? 0) > 0;
            const isNewMatch = checkResult.hasMatch && !previouslyHadMatches;

            if (isNewMatch) {
              // Per-monitor channel filtering using fresh data
              const monitorChannels = (freshMonitor as any).notificationChannels as string[] | undefined;
              const shouldSend = (channel: string) => !monitorChannels || monitorChannels.includes(channel);
              const hasAnyChannel = !monitorChannels || monitorChannels.length > 0;

              // Create in-app notification (unless all channels explicitly disabled)
              if (hasAnyChannel) await ctx.runMutation(internal.userNotifications.create, {
                userId: freshMonitor.userId,
                monitorId: freshMonitor._id,
                channel: "in_app",
                title: `${freshMonitor.name} — ${checkResult.matchCount} match${checkResult.matchCount !== 1 ? "es" : ""}`,
                message: `Found ${checkResult.matchCount} match${checkResult.matchCount !== 1 ? "es" : ""} out of ${displayTotalItems} items on ${freshMonitor.url}`,
              }).catch(() => {});

              // Send email
              if (shouldSend("email") && freshMonitor.userEmail) {
                await ctx.runAction(internal.emails.sendMatchAlert, {
                  to: freshMonitor.userEmail,
                  monitorName: freshMonitor.name,
                  monitorId: freshMonitor._id,
                  url: freshMonitor.url,
                  matchCount: checkResult.matchCount,
                  matches: checkResult.matches,
                  totalItems: displayTotalItems,
                }).catch(() => {});
              }

              // Send to Telegram if configured and enabled for this monitor
              if (shouldSend("telegram")) {
                const telegramSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
                  userId: freshMonitor.userId,
                  channel: "telegram",
                });
                if (telegramSetting?.enabled && telegramSetting.target) {
                  await ctx.runAction(internal.telegram.sendMatchAlert, {
                    chatId: telegramSetting.target,
                    monitorName: freshMonitor.name,
                    monitorId: freshMonitor._id,
                    url: freshMonitor.url,
                    matchCount: checkResult.matchCount,
                    totalItems: displayTotalItems,
                  }).catch(() => {});
                }
              }

              // Send to Discord if configured and enabled for this monitor
              if (shouldSend("discord")) {
                const discordSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
                  userId: freshMonitor.userId,
                  channel: "discord",
                });
                if (discordSetting?.enabled && discordSetting.target) {
                  await ctx.runAction(internal.discord.sendMatchAlert, {
                    webhookUrl: discordSetting.target,
                    monitorName: freshMonitor.name,
                    monitorId: freshMonitor._id,
                    url: freshMonitor.url,
                    matchCount: checkResult.matchCount,
                    totalItems: displayTotalItems,
                  }).catch(() => {});
                }
              }
            }

            // --- Price change notifications ---
            const priceAlerts = (freshMonitor as any).priceAlerts as {
              onPriceDrop: boolean;
              onPriceIncrease: boolean;
              belowThreshold?: number;
              aboveThreshold?: number;
              trackedItems: string[];
              minChangePercent?: number;
              lastNotifiedAt?: number;
              cooldownMs?: number;
            } | undefined;

            if (priceAlerts && priceAlerts.trackedItems.length > 0) {
              const latestResult = await ctx.runQuery(internal.scheduler.getLatestScrapeResult, { monitorId: freshMonitor._id });
              const changes = latestResult?.changes as { priceChanges: { title: string; oldPrice: number; newPrice: number; change: number; changePercent: number }[] } | undefined;

              if (changes?.priceChanges?.length) {
                const schema = freshMonitor.schema as any;
                const tracksPrices = schema?.insights?.tracksPrices
                  ?? (Array.isArray(schema?.items) && schema.items.some((i: any) => typeof i.price === "number"));

                if (tracksPrices) {
                  // Filter to tracked items only — match by key, fall back to title
                  // (title-price keys change when prices change, so title fallback is needed)
                  const trackedSet = new Set(priceAlerts.trackedItems);
                  const allItems = (schema?.items ?? []) as Record<string, unknown>[];
                  const trackedTitles = new Set(
                    priceAlerts.trackedItems.map((k) => {
                      const item = allItems.find((i) => {
                        const iKey = i.url ? String(i.url) : `${String(i.title ?? "")}-${String(i.price ?? "")}`;
                        return iKey === k;
                      });
                      return item ? String(item.title ?? "").toLowerCase() : k.split("-")[0]?.toLowerCase() ?? "";
                    }).filter(Boolean)
                  );
                  const relevantChanges = changes.priceChanges.filter((pc) => {
                    const item = allItems.find((i) => String(i.title ?? "").toLowerCase() === pc.title.toLowerCase());
                    if (!item) return trackedTitles.has(pc.title.toLowerCase());
                    const key = item.url ? String(item.url) : `${String(item.title ?? "")}-${String(item.price ?? "")}`;
                    return trackedSet.has(key) || trackedTitles.has(pc.title.toLowerCase());
                  });

                  // Apply minimum change threshold
                  const minPct = priceAlerts.minChangePercent ?? 2;
                  const significantChanges = relevantChanges.filter((pc) => Math.abs(pc.changePercent) >= minPct);

                  if (significantChanges.length > 0) {
                    // Check cooldown
                    const cooldownMs = priceAlerts.cooldownMs ?? 6 * 60 * 60 * 1000;
                    const lastNotified = priceAlerts.lastNotifiedAt ?? 0;

                    if (Date.now() - lastNotified >= cooldownMs) {
                      const drops = significantChanges.filter((p) => p.change < 0);
                      const increases = significantChanges.filter((p) => p.change > 0);
                      const belowHits = priceAlerts.belowThreshold != null
                        ? significantChanges.filter((p) => p.newPrice <= priceAlerts.belowThreshold!)
                        : [];
                      const aboveHits = priceAlerts.aboveThreshold != null
                        ? significantChanges.filter((p) => p.newPrice >= priceAlerts.aboveThreshold!)
                        : [];

                      const shouldNotify =
                        (priceAlerts.onPriceDrop && drops.length > 0) ||
                        (priceAlerts.onPriceIncrease && increases.length > 0) ||
                        belowHits.length > 0 ||
                        aboveHits.length > 0;

                      if (shouldNotify) {
                        // Update cooldown
                        await ctx.runMutation(internal.scheduler.updatePriceAlertTimestamp, {
                          monitorId: freshMonitor._id,
                          lastNotifiedAt: Date.now(),
                        }).catch(() => {});

                        // Determine template variant
                        const hasThresholdCrossing = belowHits.length > 0 || aboveHits.length > 0;
                        const variant = hasThresholdCrossing ? "threshold" : (drops.length === 1 && increases.length === 0 ? "single_drop" : "multiple");

                        const pricePayload = {
                          monitorName: freshMonitor.name,
                          monitorId: freshMonitor._id,
                          url: freshMonitor.url,
                          variant,
                          priceChanges: significantChanges,
                          belowThreshold: priceAlerts.belowThreshold,
                          aboveThreshold: priceAlerts.aboveThreshold,
                          belowHits,
                          aboveHits,
                          trackedItemCount: priceAlerts.trackedItems.length,
                        };

                        // Per-monitor channel filtering
                        const monitorChannels = (freshMonitor as any).notificationChannels as string[] | undefined;
                        const shouldSend = (channel: string) => !monitorChannels || monitorChannels.includes(channel);

                        // Email
                        if (shouldSend("email") && freshMonitor.userEmail) {
                          await ctx.runAction(internal.emails.sendPriceAlert, {
                            to: freshMonitor.userEmail,
                            ...pricePayload,
                          }).catch(() => {});
                        }

                        // Telegram
                        if (shouldSend("telegram")) {
                          const telegramSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
                            userId: freshMonitor.userId,
                            channel: "telegram",
                          });
                          if (telegramSetting?.enabled && telegramSetting.target) {
                            await ctx.runAction(internal.telegram.sendPriceAlert, {
                              chatId: telegramSetting.target,
                              ...pricePayload,
                            }).catch(() => {});
                          }
                        }

                        // Discord
                        if (shouldSend("discord")) {
                          const discordSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
                            userId: freshMonitor.userId,
                            channel: "discord",
                          });
                          if (discordSetting?.enabled && discordSetting.target) {
                            await ctx.runAction(internal.discord.sendPriceAlert, {
                              webhookUrl: discordSetting.target,
                              ...pricePayload,
                            }).catch(() => {});
                          }
                        }

                        // In-app notification
                        const dropCount = drops.length;
                        const incCount = increases.length;
                        const title = hasThresholdCrossing
                          ? `${freshMonitor.name} — Price target hit!`
                          : dropCount > 0 && incCount === 0
                            ? `${freshMonitor.name} — ${dropCount} price drop${dropCount !== 1 ? "s" : ""}`
                            : `${freshMonitor.name} — ${significantChanges.length} price change${significantChanges.length !== 1 ? "s" : ""}`;

                        await ctx.runMutation(internal.userNotifications.create, {
                          userId: freshMonitor.userId,
                          monitorId: freshMonitor._id,
                          channel: "in_app",
                          title,
                          message: significantChanges.map((pc) => `${pc.title}: $${pc.oldPrice} → $${pc.newPrice}`).join(", "),
                        }).catch(() => {});

                        console.log(`[scheduler] Price alert sent for ${freshMonitor._id}: ${significantChanges.length} changes, variant=${variant}`);
                      }
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          console.error(`[scheduler] Monitor ${monitor._id} failed:`, msg);

          const isTimeout =
            (e instanceof Error && e.name === "TimeoutError") ||
            msg.includes("timed out") || msg.includes("Timeout");

          // Log failed check
          await ctx.runMutation(internal.logs.createInternal, {
            userId: monitor.userId,
            monitorId: monitor._id,
            monitorName: monitor.name,
            url: monitor.url,
            prompt: monitor.prompt,
            status: isTimeout ? "timeout" : "error",
            durationMs: Date.now() - startTime,
            error: msg,
          }).catch(() => {});

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

          // Send error notifications when retries exhausted — re-fetch for fresh muted/channel state
          if (willError) {
            const freshErrMonitor = await ctx.runQuery(internal.monitors.getInternal, { id: monitor._id });
            if (freshErrMonitor && !freshErrMonitor.muted) {
              const monitorChannels = (freshErrMonitor as any).notificationChannels as string[] | undefined;
              const shouldSend = (channel: string) => !monitorChannels || monitorChannels.includes(channel);
              const hasAnyChannel = !monitorChannels || monitorChannels.length > 0;

              // In-app notification (unless all channels explicitly disabled)
              if (hasAnyChannel) await ctx.runMutation(internal.userNotifications.create, {
                userId: freshErrMonitor.userId,
                monitorId: freshErrMonitor._id,
                channel: "in_app",
                title: `${freshErrMonitor.name} — Error`,
                message: msg,
              }).catch(() => {});

              // Email
              if (shouldSend("email") && freshErrMonitor.userEmail) {
                await ctx.runAction(internal.emails.sendErrorAlert, {
                  to: freshErrMonitor.userEmail,
                  monitorName: freshErrMonitor.name,
                  monitorId: freshErrMonitor._id,
                  url: freshErrMonitor.url,
                  error: msg,
                }).catch(() => {});
              }

              // Telegram
              if (shouldSend("telegram")) {
                const telegramSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
                  userId: freshErrMonitor.userId,
                  channel: "telegram",
                });
                if (telegramSetting?.enabled && telegramSetting.target) {
                  await ctx.runAction(internal.telegram.sendErrorAlert, {
                    chatId: telegramSetting.target,
                    monitorName: freshErrMonitor.name,
                    monitorId: freshErrMonitor._id,
                    url: freshErrMonitor.url,
                    error: msg,
                  }).catch(() => {});
                }
              }

              // Discord
              if (shouldSend("discord")) {
                const discordSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
                  userId: freshErrMonitor.userId,
                  channel: "discord",
                });
                if (discordSetting?.enabled && discordSetting.target) {
                  await ctx.runAction(internal.discord.sendErrorAlert, {
                    webhookUrl: discordSetting.target,
                    monitorName: freshErrMonitor.name,
                    monitorId: freshErrMonitor._id,
                    url: freshErrMonitor.url,
                    error: msg,
                  }).catch(() => {});
                }
              }
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
): Promise<{ hasMatch: boolean; matchCount: number; matches: unknown[]; totalItems: number | null }> {
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
  return { hasMatch, matchCount: hasMatch ? 1 : 0, matches: matchData, totalItems: null };
}

async function runFullExtract(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monitor: any,
  scraperUrl: string,
  scraperKey: string
): Promise<{ hasMatch: boolean; matchCount: number; matches: unknown[]; totalItems: number | null }> {
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
      return { hasMatch: false, matchCount: 0, matches: [], totalItems: null };
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
    return { hasMatch: false, matchCount: 0, matches: [], totalItems: null };
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

/** Get the latest scrape result for a monitor (for price change notifications) */
export const getLatestScrapeResult = internalQuery({
  args: { monitorId: v.id("monitors") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("scrapeResults")
      .withIndex("by_monitorId_scrapedAt", (q) => q.eq("monitorId", args.monitorId))
      .order("desc")
      .first();
  },
});

/** Update the lastNotifiedAt timestamp inside priceAlerts (for cooldown tracking) */
export const updatePriceAlertTimestamp = internalMutation({
  args: { monitorId: v.id("monitors"), lastNotifiedAt: v.number() },
  handler: async (ctx, args) => {
    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor) return;
    const existing = (monitor as any).priceAlerts;
    if (!existing) return;
    await ctx.db.patch(args.monitorId, {
      priceAlerts: { ...existing, lastNotifiedAt: args.lastNotifiedAt },
    } as any);
  },
});
