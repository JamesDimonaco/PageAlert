import { v } from "convex/values";
import { effectiveTier } from "./tiers";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  displayHost,
  isBlockedError,
  matchKey,
  newMatchKeys,
  ERROR_RECOVERY_INTERVAL_MS,
  effectiveIntervalMs,
  MAX_RETRIES,
  MAX_PROXY_BLOCKS,
  PROXY_REPROBE_EVERY,
} from "./shared";

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

const MAX_CONCURRENT_CHECKS = 10;

// How long a monitor's schema is trusted before the AI re-reads the page to
// catch its structure drifting away from what the schema was built from
const AI_REEXTRACT_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Decide whether a scheduled check should re-run the AI extract.
 *
 * Re-extraction costs an Anthropic call per monitor, so a changed page is not
 * on its own a reason to spend one. The two paths that do warrant the AI have
 * their own triggers and do not come through here: an explicit rescan from the
 * monitor page, and the post-failure retry in runScheduledChecks. Everything
 * else waits for the drift refresh.
 *
 * Measured in elapsed time, not checks, so the bill doesn't scale with how
 * often a monitor is checked — the earlier count-based rule meant an hourly
 * monitor re-extracted six times as often as a six-hourly one for no gain.
 * Unlike the per-tier cooldown this replaces (#49), it applies to free too.
 */
function shouldEscalateToAI(monitor: { lastAiExtractAt?: number; _creationTime: number }): boolean {
  // Rows with no stamp fall back to their creation time — without that, an
  // absent value would read as "due". Rows still carrying a stamp from the
  // pre-#49 cooldown are months stale and do all refresh shortly after this
  // ships; that is one AI call each, spread across their own cadences, and
  // those schemas are four months old anyway.
  const lastExtract = monitor.lastAiExtractAt ?? monitor._creationTime;
  return Date.now() - lastExtract >= AI_REEXTRACT_AFTER_MS;
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
    // Set when this failure was a Scrapfly-confirmed anti-bot block (not an
    // outage or spent credit budget) — see MAX_PROXY_BLOCKS in shared.ts
    confirmedProxyBlock: v.optional(v.boolean()),
    // Fingerprint of the page content this check observed
    contentFingerprint: v.optional(v.string()),
    // Page content identical to last scan — bookkeeping only, no result row
    unchanged: v.optional(v.boolean()),
    // Set only by the full-extract path, where matches are real items with
    // identities. The quick-check path has no per-item data to diff.
    trackMatchKeys: v.optional(v.boolean()),
    // Whether this check went through the proxy — drives proxyPreferred.
    usedProxy: v.optional(v.boolean()),
    // The AI re-read the page on this check. Set even when the extract came
    // back too weak to use, because the call was still paid for.
    aiExtracted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor || (monitor.status !== "active" && monitor.status !== "error")) {
      return { parked: false, newMatchKeys: [] as string[] };
    }

    const now = Date.now();

    if (args.error) {
      const retryCount = (monitor.retryCount ?? 0) + 1;
      const proxyBlockCount = (monitor.proxyBlockCount ?? 0) + (args.confirmedProxyBlock ? 1 : 0);

      // Scrapfly has genuinely beaten this site — stop rescheduling instead of
      // paying for another blocked attempt every 6 hours. nextCheckAt: undefined
      // sorts before getMonitorsDue's .gte("nextCheckAt", 0) bound, so this
      // monitor is parked until the user retries it by hand.
      if (args.confirmedProxyBlock && proxyBlockCount >= MAX_PROXY_BLOCKS) {
        await ctx.db.patch(args.monitorId, {
          status: "error",
          lastError: "Checks have stopped: this site blocks automated access even through our proxy. Use Retry to try again.",
          retryCount,
          proxyBlockCount,
          nextCheckAt: undefined,
          updatedAt: now,
        });
        return { parked: true, newMatchKeys: [] as string[] };
      }

      if (retryCount >= MAX_RETRIES) {
        await ctx.db.patch(args.monitorId, {
          status: "error",
          lastError: args.error,
          retryCount,
          proxyBlockCount,
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
          proxyBlockCount,
          nextCheckAt: now + backoffMs,
          updatedAt: now,
        });
      }
      return { parked: false, newMatchKeys: [] as string[] };
    }

    // Success
    const updates: Record<string, unknown> = {
      status: "active",
      matchCount: args.matchCount,
      checkCount: (monitor.checkCount ?? 0) + 1,
      retryCount: 0,
      proxyBlockCount: 0,
      lastCheckedAt: now,
      nextCheckAt: now + effectiveIntervalMs(monitor),
      updatedAt: now,
      lastError: undefined,
    };

    // Restart the drift clock whenever the AI read the page, whatever brought
    // it here and whatever came back. Stamping only on a usable schema would
    // leave a monitor that keeps extracting badly permanently past its
    // refresh deadline, re-extracting on every single check.
    if (args.aiExtracted) {
      updates.lastAiExtractAt = now;
    }

    if (args.matchCount > 0 && !args.unchanged) {
      updates.lastMatchAt = now;
    }

    if (args.schema) {
      updates.schema = args.schema;
    }

    if (args.contentFingerprint) {
      updates.contentFingerprint = args.contentFingerprint;
    }

    // Remember whether this site needs the proxy at all. A direct success
    // clears the flag, which is also how the periodic re-probe takes effect.
    const nextProxyPreferred =
      args.usedProxy === true
        ? isBlockedError(monitor.lastError ?? "") || monitor.proxyPreferred === true
        : args.usedProxy === false
          ? false
          : monitor.proxyPreferred;
    if (nextProxyPreferred !== monitor.proxyPreferred) {
      updates.proxyPreferred = nextProxyPreferred;
    }

    // Which of this check's matches the user has not been told about. Computed
    // here because this is the last point that still holds the pre-check
    // monitor doc.
    let newKeys: string[] = [];
    // An extract that saw no items at all is a render that went wrong, not a
    // page that emptied. Keeping the old baseline there stops the items coming
    // back as "12 new matches" the user has already been told about. A page
    // that genuinely holds items but matches none of them does clear it, and
    // a later reappearance is a real event worth an alert.
    if (args.trackMatchKeys && (args.matches.length > 0 || args.totalItems > 0)) {
      const currentKeys = (args.matches as Record<string, unknown>[]).map(matchKey);
      newKeys = newMatchKeys(monitor.matchedKeys, currentKeys);
      updates.matchedKeys = [...new Set(currentKeys.filter(Boolean))];
    }

    await ctx.db.patch(args.monitorId, updates);

    // Unchanged page: monitor bookkeeping is done, skip the scrapeResults
    // insert — no new data to record and no changes to detect
    if (args.unchanged) return { parked: false, newMatchKeys: [] as string[] };

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

    return { parked: false, newMatchKeys: newKeys };
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
        // This site has only ever answered through the proxy, so the direct
        // attempt is a guaranteed failure plus a wasted 2-minute backoff before
        // the alert. Probe direct occasionally in case the site drops its WAF.
        const reprobeDirect = ((monitor.checkCount ?? 0) + 1) % PROXY_REPROBE_EVERY === 0;
        const wantProxy =
          (monitor.proxyPreferred === true && !reprobeDirect) ||
          (retryCount >= 1 && isBlockedError(monitor.lastError ?? ""));

        // A fleet-wide failure is ours, not the sites'. Escalating during a
        // scraper outage bought 113 proxy calls in one hour on 2026-09-05 and
        // fixed nothing.
        const scraperDown = wantProxy
          ? await ctx.runQuery(internal.admin.isScraperDown, {})
          : false;

        // An escalation is a reach for the proxy after a block; a
        // proxy-preferred check is routine traffic for a site we already know
        // needs it. Only the first kind counts against the burst cap.
        const useProxy =
          wantProxy &&
          !scraperDown &&
          (await ctx.runMutation(internal.admin.reserveFallbackCall, {
            escalation: monitor.proxyPreferred !== true || reprobeDirect,
          }));
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

            // The full-extract path knows which items are new, so use that.
            // The quick-check path has no item identity — its matchCount is a
            // consecutive-hit streak, so the old zero-to-something transition
            // is still the only signal available there.
            const isNewMatch = checkResult.newMatchKeys
              ? checkResult.newMatchKeys.length > 0
              : checkResult.hasMatch && (monitor.matchCount ?? 0) === 0;
            const newCount = checkResult.newMatchKeys?.length ?? checkResult.matchCount;

            if (isNewMatch) {
              // Only the items the user has not seen. On the quick-check path
              // there is nothing to narrow to, so this is the whole match set.
              const newKeys = new Set(checkResult.newMatchKeys ?? []);
              const newMatches = checkResult.newMatchKeys
                ? (checkResult.matches as Record<string, unknown>[]).filter((m) => newKeys.has(matchKey(m)))
                : (checkResult.matches as Record<string, unknown>[]);
              const plural = newCount !== 1 ? "es" : "";

              await ctx.scheduler.runAfter(0, internal.admin.notify, {
                text: `Match: ${freshMonitor.name} found ${newCount} new on ${displayHost(freshMonitor.url)} (${freshMonitor.userEmail ?? "no email"})`,
              });

              // Create in-app notification (unless all channels explicitly disabled)
              if (hasAnyChannel) await ctx.runMutation(internal.userNotifications.create, {
                userId: freshMonitor.userId,
                monitorId: freshMonitor._id,
                channel: "in_app",
                title: `${freshMonitor.name} — ${newCount} new match${plural}`,
                message: `Found ${newCount} new match${plural} out of ${displayTotalItems} items on ${freshMonitor.url}`,
              }).catch(() => {});

              // Push. No settings lookup — a user's devices are the target,
              // and push.ts resolves them. Same wording as the in-app card.
              if (shouldSend("push")) {
                await ctx.runAction(internal.push.sendToUser, {
                  userId: freshMonitor.userId,
                  monitorId: freshMonitor._id,
                  title: `${freshMonitor.name} — ${newCount} new match${plural}`,
                  body: `${newCount} new match${plural} out of ${displayTotalItems} items on ${displayHost(freshMonitor.url)}`,
                }).catch(() => {});
              }

              // Send email
              if (shouldSend("email") && freshMonitor.userEmail) {
                await ctx.runAction(internal.emails.sendMatchAlert, {
                  to: freshMonitor.userEmail,
                  monitorName: freshMonitor.name,
                  monitorId: freshMonitor._id,
                  url: freshMonitor.url,
                  matchCount: newCount,
                  matches: newMatches,
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
                    matchCount: newCount,
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
                    matchCount: newCount,
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

                          if (shouldSend("push")) {
                            await ctx.runAction(internal.push.sendToUser, {
                              userId: freshMonitor.userId,
                              monitorId: freshMonitor._id,
                              title,
                              body: significantChanges
                                .map((pc) => `${pc.title}: $${pc.oldPrice} → $${pc.newPrice}`)
                                .join(", "),
                            }).catch(() => {});
                          }
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
          const isFallbackProviderError = msg.startsWith("Fallback provider error");
          // A block only counts against the monitor when Scrapfly itself
          // confirmed it (ERR::ASP::* via useProxy) — a Scrapfly outage or a
          // spent credit budget must never park a user's monitor.
          // Only counted on the 6h recovery lane. The fast ladder retries at 2min
          // and 8min, so counting there would park a monitor inside a single
          // Cloudflare spike — both blocks have to be hours apart to mean
          // anything.
          const confirmedProxyBlock =
            useProxy && isBlocked && !isFallbackProviderError && retryCount >= MAX_RETRIES;
          if (isFallbackProviderError) {
            const send = await ctx.runMutation(internal.admin.claimAlertSlot, { key: "admin:fallback-provider", minIntervalMs: 60 * 60 * 1000 });
            if (send) await ctx.scheduler.runAfter(0, internal.admin.notify, { text: `Scrapfly is failing: ${msg.slice(0, 300)}` });
          }
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

          const outcome = await ctx.runMutation(internal.scheduler.recordCheckResult, {
            monitorId: monitor._id,
            hasNewMatches: false,
            matchCount: 0,
            totalItems: 0,
            matches: [],
            error: msg,
            confirmedProxyBlock,
          });
          // Parking almost always happens while the monitor is already in
          // "error", which willError deliberately stays quiet about. Without
          // this the monitor stops being checked and nobody is told.
          const parked = outcome?.parked === true;

          // Re-fetch for fresh muted/channel state
          if (parked || willError) {
            const freshErrMonitor = await ctx.runQuery(internal.monitors.getInternal, { id: monitor._id });
            if (freshErrMonitor && !freshErrMonitor.muted) {
              const monitorChannels = (freshErrMonitor as any).notificationChannels as string[] | undefined;
              const shouldSend = (channel: string) => !monitorChannels || monitorChannels.includes(channel);
              const hasAnyChannel = !monitorChannels || monitorChannels.length > 0;

              // Looked up before the sends so the email knows whether to nudge
              // the user towards Telegram. Not gated on shouldSend: a user who
              // already has Telegram must not be told to go connect it.
              const telegramSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
                userId: freshErrMonitor.userId,
                channel: "telegram",
              });
              const telegramConnected = !!(telegramSetting?.enabled && telegramSetting.target);

              // In-app notification (unless all channels explicitly disabled)
              if (parked || hasAnyChannel) await ctx.runMutation(internal.userNotifications.create, {
                userId: freshErrMonitor.userId,
                monitorId: freshErrMonitor._id,
                channel: "in_app",
                title: `${freshErrMonitor.name} — ${parked ? "Checks stopped" : "Error"}`,
                message: parked ? (freshErrMonitor.lastError ?? msg) : msg,
              }).catch(() => {});

              // A park overrides channel selection on push for the same reason
              // it does on email below: it is the last thing we will ever say
              // about this monitor, so it should not be silently suppressed.
              if (parked || shouldSend("push")) {
                await ctx.runAction(internal.push.sendToUser, {
                  userId: freshErrMonitor.userId,
                  monitorId: freshErrMonitor._id,
                  title: `${freshErrMonitor.name} — ${parked ? "Checks stopped" : "Error"}`,
                  body: parked ? (freshErrMonitor.lastError ?? msg) : msg,
                }).catch(() => {});
              }

              // Email is the one channel a park overrides selection on: it is the
              // only one every user has. Telegram and Discord stay opt-in below,
              // so a park still reaches everyone without spamming a channel
              // someone deliberately turned off for this monitor.
              if ((parked || shouldSend("email")) && freshErrMonitor.userEmail) {
                if (parked) {
                  await ctx.runAction(internal.emails.sendMonitorStoppedAlert, {
                    to: freshErrMonitor.userEmail,
                    monitorName: freshErrMonitor.name,
                    monitorId: freshErrMonitor._id,
                    url: freshErrMonitor.url,
                    telegramConnected,
                  }).catch(() => {});
                } else {
                  await ctx.runAction(internal.emails.sendErrorAlert, {
                    to: freshErrMonitor.userEmail,
                    monitorName: freshErrMonitor.name,
                    monitorId: freshErrMonitor._id,
                    url: freshErrMonitor.url,
                    error: msg,
                  }).catch(() => {});
                }
              }

              // Telegram
              if (shouldSend("telegram") && telegramSetting?.enabled && telegramSetting.target) {
                if (parked) {
                  await ctx.runAction(internal.telegram.sendMonitorStoppedAlert, {
                    chatId: telegramSetting.target,
                    monitorName: freshErrMonitor.name,
                    monitorId: freshErrMonitor._id,
                    url: freshErrMonitor.url,
                  }).catch(() => {});
                } else {
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
                  if (parked) {
                    await ctx.runAction(internal.discord.sendMonitorStoppedAlert, {
                      webhookUrl: discordSetting.target,
                      monitorName: freshErrMonitor.name,
                      monitorId: freshErrMonitor._id,
                      url: freshErrMonitor.url,
                    }).catch(() => {});
                  } else {
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
  /**
   * Matched items the user has not been told about, from the full-extract
   * path. Undefined on the quick-check path, whose "matches" carry no item
   * identity — that path still notifies on the no-match-to-match transition.
   */
  newMatchKeys?: string[];
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
    return runFullExtract(ctx, monitor, scraperUrl, scraperKey, retryAttempt, { useProxy, skipQuickCheck: true });
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
      usedProxy: useProxy,
    });
    console.log(`[scheduler] Quick check ${monitor._id}: content unchanged, skipping`);
    return { hasMatch: false, matchCount: monitor.matchCount ?? 0, matches: [], totalItems: null, strategy: "unchanged" };
  }

  // Content changed (or no fingerprint stored yet). The AI only re-reads the
  // page on the drift refresh — see shouldEscalateToAI.
  if (shouldEscalateToAI(monitor)) {
    console.log(`[scheduler] Quick check ${monitor._id}: schema is stale, running AI drift re-extract`);
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
    usedProxy: useProxy,
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
      aiExtracted: true,
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

  const outcome = await ctx.runMutation(internal.scheduler.recordCheckResult, {
    monitorId: monitor._id,
    hasNewMatches: matchCount > 0,
    matchCount,
    totalItems,
    matches: filteredMatches,
    items: result.schema?.items ?? [],
    schema: result.schema,
    contentFingerprint: contentHash,
    trackMatchKeys: true,
    usedProxy: useProxy,
    aiExtracted: true,
  });

  console.log(`[scheduler] Full re-extract ${monitor._id}: ${totalItems} items, ${matchCount} matches (${allMatches.length - matchCount} blacklisted)`);

  return {
    hasMatch: matchCount > 0,
    matchCount,
    matches: filteredMatches,
    totalItems,
    strategy,
    newMatchKeys: outcome?.newMatchKeys ?? [],
  };
}

/** Internal: resolve a user's tier — gates the post-failure full extract */
export const getUserTier = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    return effectiveTier(record);
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
