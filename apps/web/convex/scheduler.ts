import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { displayHost, isBlockedError, ERROR_RECOVERY_INTERVAL_MS, intervalToMs, MAX_RETRIES } from "./shared";

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

// A monitor re-runs the AI extract once every this many completed checks, to
// catch the page structure drifting away from the schema it was built from
const AI_REEXTRACT_EVERY_N_CHECKS = 100;

/**
 * Decide whether a scheduled check should re-run the AI extract.
 *
 * Re-extraction costs an Anthropic call per monitor, so a changed page is not
 * on its own a reason to spend one. The two paths that do warrant the AI have
 * their own triggers and do not come through here: an explicit rescan from the
 * monitor page, and the post-failure retry in runScheduledChecks. Everything
 * else waits for the drift refresh.
 */
function shouldEscalateToAI(monitor: { checkCount?: number }): boolean {
  // checkCount is incremented by recordCheckResult after this runs, so count
  // the check in flight or the boundary is missed
  const completedChecks = (monitor.checkCount ?? 0) + 1;
  return completedChecks % AI_REEXTRACT_EVERY_N_CHECKS === 0;
}

/** Query monitors that are due for a check */
export const getMonitorsDue = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Compound index: status="active" + nextCheckAt <= now
    // Only reads active monitors that are actually due, not the whole table
    const active = await ctx.db
      .query("monitors")
      .withIndex("by_status_nextCheckAt", (q) =>
        q.eq("status", "active").gte("nextCheckAt", 0).lte("nextCheckAt", now)
      )
      .take(MAX_CONCURRENT_CHECKS);

    // Errored monitors get a slow retry lane. Without this an outage that
    // outlasts MAX_RETRIES parks every monitor permanently — which is exactly
    // what happened when the scraper went down on 19 May 2026. One slot is
    // always held for recovery so a busy active queue can't starve it.
    // The lower bound keeps out monitors with no due time at all (anonymous
    // scans), which sort before every number in the index.
    const recovering = await ctx.db
      .query("monitors")
      .withIndex("by_status_nextCheckAt", (q) =>
        q.eq("status", "error").gte("nextCheckAt", 0).lte("nextCheckAt", now)
      )
      .take(MAX_CONCURRENT_CHECKS);

    const activeSlots = MAX_CONCURRENT_CHECKS - Math.min(recovering.length, 1);
    const picked = active.slice(0, activeSlots);
    return [...picked, ...recovering.slice(0, MAX_CONCURRENT_CHECKS - picked.length)];
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
    // Fingerprint of the page content this check observed
    contentFingerprint: v.optional(v.string()),
    // Page content identical to last scan — bookkeeping only, no result row
    unchanged: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor || (monitor.status !== "active" && monitor.status !== "error")) return;

    const now = Date.now();

    if (args.error) {
      const retryCount = (monitor.retryCount ?? 0) + 1;
      if (retryCount >= MAX_RETRIES) {
        await ctx.db.patch(args.monitorId, {
          status: "error",
          lastError: args.error,
          retryCount,
          // Keep it scheduled, slowly. A monitor that dies during an outage
          // has to be able to come back on its own once the outage ends.
          nextCheckAt: now + ERROR_RECOVERY_INTERVAL_MS,
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

    if (args.matchCount > 0 && !args.unchanged) {
      updates.lastMatchAt = now;
    }

    if (args.schema) {
      updates.schema = args.schema;
    }

    if (args.contentFingerprint) {
      updates.contentFingerprint = args.contentFingerprint;
    }

    await ctx.db.patch(args.monitorId, updates);

    // Unchanged page: monitor bookkeeping is done, skip the scrapeResults
    // insert — no new data to record and no changes to detect
    if (args.unchanged) return;

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
        // The recovery lane keeps counting past MAX_RETRIES. Cap it here: the
        // scraper rejects retryAttempt > 10 with a 400, which would park the
        // monitor for good, and forceFullExtract below keys off the exact value.
        const retryCount = Math.min(monitor.retryCount ?? 0, MAX_RETRIES);
        // Use proxy on retry 1+ to bypass anti-bot IP blocking
        const useProxy = retryCount >= 1;
        let strategyLabel = "quick-check";
        try {
          const tier = await ctx.runQuery(internal.scheduler.getUserTier, { userId: monitor.userId });
          // On the 3rd attempt only, skip quick-check and go straight to full
          // extract with proxy — the AI may handle challenge content better.
          // Paid tiers only; free stays on the deterministic path with proxy.
          // Not on the 6h recovery lane (retryCount above that), or a dead URL
          // would cost an AI call four times a day forever.
          const forceFullExtract = retryCount === 2 && tier !== "free";

          let checkResult: CheckOutcome;

          if (forceFullExtract) {
            strategyLabel = "forced-extract";
            checkResult = await runFullExtract(ctx, monitor, scraperUrl, scraperKey, retryCount, {
              skipQuickCheck: true,
              skipBlockCheck: true,
              useProxy,
            });
          } else {
            checkResult = await runQuickCheck(ctx, monitor, scraperUrl, scraperKey, retryCount, useProxy);
          }
          strategyLabel = checkResult.strategy;

          // Log successful check — use monitor's last known item count when totalItems is unknown
          const displayTotalItems = checkResult.totalItems != null
            ? checkResult.totalItems
            : (Array.isArray((monitor.schema as any)?.items) ? (monitor.schema as any).items.length : 0);
          const strategy = `${strategyLabel}${useProxy ? "+proxy" : ""}`;
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
            retryAttempt: retryCount > 0 ? retryCount : undefined,
            strategy,
          }).catch(() => {});

          // Re-fetch monitor to pick up any user changes (muted, channels) during the long-running check
          const freshMonitor = await ctx.runQuery(internal.monitors.getInternal, { id: monitor._id });
          if (!freshMonitor || freshMonitor.muted) {
            if (!freshMonitor) console.log(`[scheduler] Monitor ${monitor._id} deleted during check, skipping notifications`);
            // Data already recorded above — just skip notifications
          } else {
            // Per-monitor channel filtering using fresh data (shared by match + price notifications)
            const monitorChannels = (freshMonitor as any).notificationChannels as string[] | undefined;
            const shouldSend = (channel: string) => !monitorChannels || monitorChannels.includes(channel);
            const hasAnyChannel = !monitorChannels || monitorChannels.length > 0;

            // Only notify on NEW matches (not when the same match persists across checks)
            const previouslyHadMatches = (monitor.matchCount ?? 0) > 0;
            const isNewMatch = checkResult.hasMatch && !previouslyHadMatches;

            if (isNewMatch) {
              await ctx.scheduler.runAfter(0, internal.admin.notify, {
                text: `Match: ${freshMonitor.name} found ${checkResult.matchCount} on ${displayHost(freshMonitor.url)} (${freshMonitor.userEmail ?? "no email"})`,
              });

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
                  tracksPrices: !!(freshMonitor.schema as any)?.insights?.tracksPrices,
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
                  // Filter to tracked items by title — title-price composite keys are unstable
                  // across price changes, so we resolve tracked keys to titles and match on that
                  const allItems = (schema?.items ?? []) as Record<string, unknown>[];
                  const trackedTitles = new Set(
                    priceAlerts.trackedItems.map((k) => {
                      // Try to find the item by key to get its title
                      const item = allItems.find((i) => {
                        const iKey = i.url ? String(i.url) : `${String(i.title ?? "")}-${String(i.price ?? "")}`;
                        return iKey === k;
                      });
                      if (item) return String(item.title ?? "").toLowerCase();
                      // For URL keys, check if any item has this URL
                      const byUrl = allItems.find((i) => String(i.url ?? "") === k);
                      if (byUrl) return String(byUrl.title ?? "").toLowerCase();
                      // Last resort: extract title portion from title-price key
                      return k.split("-").slice(0, -1).join("-").toLowerCase() || k.toLowerCase();
                    }).filter(Boolean)
                  );
                  const relevantChanges = changes.priceChanges.filter((pc) =>
                    trackedTitles.has(pc.title.toLowerCase())
                  );

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
                        }).catch((e) => console.error(`[scheduler] Failed to update price alert cooldown for ${freshMonitor._id} — may cause duplicate alerts:`, e));

                        // Determine template variant
                        const hasThresholdCrossing = belowHits.length > 0 || aboveHits.length > 0;
                        const variant: "threshold" | "single_drop" | "multiple" = hasThresholdCrossing ? "threshold" : (drops.length === 1 && increases.length === 0 ? "single_drop" : "multiple");

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
                        await ctx.scheduler.runAfter(0, internal.admin.notify, {
                          text: `Price ${variant}: ${freshMonitor.name} on ${displayHost(freshMonitor.url)}, ${significantChanges.length} change(s) (${freshMonitor.userEmail ?? "no email"})`,
                        });

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

                        // In-app notification (unless all channels explicitly disabled)
                        if (hasAnyChannel) {
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
                        }

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
          const isBlocked = isBlockedError(msg);
          if (/AI service error 40[01]|authentication error|credit balance|billing/i.test(msg)) {
            const send = await ctx.runMutation(internal.admin.claimAlertSlot, { key: "admin:ai-credit", minIntervalMs: 60 * 60 * 1000 });
            if (send) await ctx.scheduler.runAfter(0, internal.admin.notify, { text: `Anthropic is rejecting calls: ${msg.slice(0, 300)}` });
          }
          const failStrategy = `${strategyLabel}${useProxy ? "+proxy" : ""}`;
          await ctx.runMutation(internal.logs.createInternal, {
            userId: monitor.userId,
            monitorId: monitor._id,
            monitorName: monitor.name,
            url: monitor.url,
            prompt: monitor.prompt,
            status: isTimeout ? "timeout" : "error",
            durationMs: Date.now() - startTime,
            error: msg,
            retryAttempt: retryCount > 0 ? retryCount : undefined,
            blocked: isBlocked || undefined,
            blockReason: isBlocked ? msg.slice(0, 200) : undefined,
            strategy: failStrategy,
          }).catch(() => {});

          // Notify once, on the transition into error. Recovery-lane retries
          // keep failing with retryCount past MAX_RETRIES and must stay quiet.
          const nextRetryCount = (monitor.retryCount ?? 0) + 1;
          const willError = nextRetryCount >= MAX_RETRIES && monitor.status !== "error";

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

type CheckOutcome = {
  hasMatch: boolean;
  matchCount: number;
  matches: unknown[];
  totalItems: number | null;
  strategy: string;
};

async function runQuickCheck(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monitor: any,
  scraperUrl: string,
  scraperKey: string,
  retryAttempt = 0,
  useProxy = false
): Promise<CheckOutcome> {
  // No schema means the first extract never succeeded. A quick-check with
  // empty conditions matches any accessible page, so do the extract instead.
  if (!monitor.schema) {
    return runFullExtract(ctx, monitor, scraperUrl, scraperKey, retryAttempt, { useProxy });
  }

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
      ...(retryAttempt > 0 ? { retryAttempt } : {}),
      ...(useProxy ? { useProxy: true } : {}),
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Try to extract the user-friendly message from the scraper's JSON response
    let errorMsg = `Scraper error (${res.status})`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.message) errorMsg = parsed.message;
    } catch {
      if (body) errorMsg = `${errorMsg}: ${body.slice(0, 200)}`;
    }
    throw new Error(errorMsg);
  }

  const result = await res.json();

  if (!result.accessible) {
    const reason = result.blocked
      ? `Site is blocking automated access: ${result.blockReason ?? "anti-bot protection detected"}. Try a different URL or check if the site requires login.`
      : "Page inaccessible — no meaningful content found. The page may be down or require JavaScript that couldn't load.";
    throw new Error(reason);
  }

  const contentHash: string | undefined = result.contentHash;

  // Cheap short-circuit: content identical to the last scan — record the
  // check happened and stop. No AI, no result row, no notifications.
  if (contentHash && monitor.contentFingerprint && contentHash === monitor.contentFingerprint) {
    await ctx.runMutation(internal.scheduler.recordCheckResult, {
      monitorId: monitor._id,
      hasNewMatches: false,
      matchCount: monitor.matchCount ?? 0,
      totalItems: 0,
      matches: [],
      unchanged: true,
    });
    console.log(`[scheduler] Quick check ${monitor._id}: content unchanged, skipping`);
    return { hasMatch: false, matchCount: monitor.matchCount ?? 0, matches: [], totalItems: null, strategy: "unchanged" };
  }

  // Content changed (or no fingerprint stored yet). The AI only re-reads the
  // page on the drift refresh — see shouldEscalateToAI.
  if (shouldEscalateToAI(monitor)) {
    console.log(`[scheduler] Quick check ${monitor._id}: check ${(monitor.checkCount ?? 0) + 1}, running AI drift re-extract`);
    return runFullExtract(ctx, monitor, scraperUrl, scraperKey, retryAttempt, {
      // Page was fetched and accessible moments ago — skip the redundant pre-check
      skipQuickCheck: true,
      useProxy,
      contentHash,
    });
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
    contentFingerprint: contentHash,
  });

  console.log(`[scheduler] Quick check ${monitor._id}: ${hasMatch ? "MATCH" : "no match"}`);

  const matchData = hasMatch
    ? [{ quickCheck: true, keywordResults: result.keywordResults, priceResults: result.priceResults }]
    : [];
  return { hasMatch, matchCount: hasMatch ? 1 : 0, matches: matchData, totalItems: null, strategy: "quick-check" };
}

async function runFullExtract(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monitor: any,
  scraperUrl: string,
  scraperKey: string,
  retryAttempt = 0,
  opts: {
    /** Skip the accessibility pre-check (caller just fetched the page) */
    skipQuickCheck?: boolean;
    /** Tell the scraper to attempt extraction even on anti-bot challenge pages */
    skipBlockCheck?: boolean;
    useProxy?: boolean;
    /** Fingerprint already computed by the caller's quick-check */
    contentHash?: string;
  } = {}
): Promise<CheckOutcome> {
  const { skipQuickCheck = false, skipBlockCheck = false, useProxy = false } = opts;
  let contentHash = opts.contentHash;
  const strategy = skipBlockCheck ? "forced-extract" : "ai-extract";

  // Skip the accessibility pre-check when forced (e.g., on retry after anti-bot detection)
  // — go straight to the AI extract which may handle partial/challenge content better
  if (!skipQuickCheck) {
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
        ...(retryAttempt > 0 ? { retryAttempt } : {}),
        ...(useProxy ? { useProxy: true } : {}),
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
        return { hasMatch: false, matchCount: 0, matches: [], totalItems: null, strategy };
      }
      contentHash = quickResult.contentHash ?? contentHash;
    }
  } else {
    console.log(`[scheduler] Skipping quick-check for ${monitor._id} (retry ${retryAttempt}, forced full extract)`);
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
      ...(retryAttempt > 0 ? { retryAttempt } : {}),
      ...(skipBlockCheck ? { skipBlockCheck: true } : {}),
      ...(useProxy ? { useProxy: true } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let errorMsg = `AI extract failed (${res.status})`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.message) errorMsg = parsed.message;
    } catch {
      if (body) errorMsg = `${errorMsg}: ${body.slice(0, 200)}`;
    }
    throw new Error(errorMsg);
  }

  const result = await res.json();
  contentHash = result.contentHash ?? contentHash;

  // If low confidence + no items, keep existing schema
  const confidence = result.schema?.insights?.confidence ?? 100;
  if (confidence <= 10 && (result.totalItems ?? 0) === 0) {
    // With no schema to fall back on this is a real failure: recording it
    // as success would mark the monitor active with nothing to watch.
    if (!monitor.schema) {
      throw new Error("AI could not find anything to watch on this page - try a more specific prompt");
    }
    // Soft failure — don't count as retry. Keep the old fingerprint so the
    // next drift refresh gets another go at it.
    console.log(`[scheduler] Re-extract ${monitor._id}: low confidence (${confidence}%), keeping existing schema`);
    await ctx.runMutation(internal.scheduler.recordCheckResult, {
      monitorId: monitor._id,
      hasNewMatches: false,
      matchCount: monitor.matchCount ?? 0,
      totalItems: 0,
      matches: [],
      // No error field — informational, not retry-worthy
    });
    return { hasMatch: false, matchCount: 0, matches: [], totalItems: null, strategy };
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
    contentFingerprint: contentHash,
  });

  console.log(`[scheduler] Full re-extract ${monitor._id}: ${totalItems} items, ${matchCount} matches (${allMatches.length - matchCount} blacklisted)`);

  return { hasMatch: matchCount > 0, matchCount, matches: filteredMatches, totalItems, strategy };
}

/** Internal: resolve a user's tier — gates the post-failure full extract */
export const getUserTier = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    return (record?.tier as "free" | "pro" | "max" | undefined) ?? "free";
  },
});

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
    // as any: priceAlerts type not in generated types until npx convex dev runs
    const existing = (monitor as any).priceAlerts;
    if (!existing) return;
    await ctx.db.patch(args.monitorId, {
      priceAlerts: { ...existing, lastNotifiedAt: args.lastNotifiedAt },
    } as any);
  },
});
