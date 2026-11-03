import { v, type Infer } from "convex/values";
import { effectiveTier } from "./tiers";
import { claimActivation } from "./monitors";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { formatMinorUnits, formatSmsPrice, isProductMonitor } from "@prowl/shared";
import { alertChannels, deliverAlert } from "./alerts";
import {
  displayHost,
  isBlockedError,
  matchKey,
  newMatchKeys,
  ERROR_RECOVERY_INTERVAL_MS,
  effectiveIntervalMs,
  MAX_RETRIES,
  ERROR_ALERT_COOLDOWN_MS,
  MAX_PROXY_BLOCKS,
  MAX_NEVER_SUCCEEDED_RETRIES,
  PARK_REASON_PROXY_BLOCKED,
  PARK_REASON_NEVER_SUCCEEDED,
  alertsOnScore,
  canonicalUrl,
  PROXY_REPROBE_EVERY,
} from "./shared";

/** The fields both check paths agree on. Everything item-shaped in here satisfies it. */
type ItemLike = { title?: unknown; name?: unknown; url?: unknown; price?: unknown };

/**
 * One row per entry.
 *
 * Canonical identity made duplicate links to one listing collapse, which is
 * routine — Amazon shows the same product as both a sponsored and an organic
 * result. Left in, the same product is judged twice, burns two of the
 * per-check scoring slots, and an alert saying "1 new match" lists it twice.
 */
function dedupeByKey<T extends ItemLike>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = matchKey(item);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Filter out blacklisted items from a matches array based on item title/url keys */
function filterBlacklisted<T extends ItemLike>(matches: T[], blacklist: string[]): T[] {
  if (!blacklist || blacklist.length === 0) return matches;
  // Both forms of every stored key. A blacklist entry saved from a listing
  // whose URL carries a per-request token would otherwise stop matching the
  // moment the page was scraped again, and the hidden item would come back.
  const blacklistSet = new Set<string>();
  for (const key of blacklist) {
    blacklistSet.add(key);
    blacklistSet.add(canonicalUrl(key));
  }
  return matches.filter((m) => {
    // Match the same key logic as getItemKey in @prowl/shared
    const url = m.url ? String(m.url) : null;
    const key = url ?? `${String(m.title ?? "")}-${String(m.price ?? "")}`;
    return !blacklistSet.has(key) && !blacklistSet.has(canonicalUrl(key));
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

/** How long after creating a product its owner may still be on the progress screen. */
const PRODUCT_SCAN_WATCHED_MS = 15 * 60 * 1000;

/** A product monitor whose owner wants a stock or price alert. */
function wantsProductRead(monitor: Pick<Doc<"monitors">, "alertOn" | "schema" | "groupId">): boolean {
  const on = monitor.alertOn;
  const wanted = on?.backInStock === true || on?.priceDrop === true || on?.priceBelow !== undefined;
  return wanted && isProductMonitor(monitor);
}

/** The scraper rejects longer titles with a 400, which would fail every check until the monitor parks. */
const MAX_PRODUCT_TITLE = 500;

/**
 * The product's name, for finding it on the page and naming it in alerts. A
 * listing in a product uses its search result's title, because its page may
 * hold several items and the first need not be the product. Otherwise it is
 * the last full read's.
 */
function productTitle(monitor: Pick<Doc<"monitors">, "name" | "schema" | "productTitle">): string {
  const title =
    monitor.productTitle ?? (monitor.schema as { items?: { title?: unknown }[] } | undefined)?.items?.[0]?.title;
  const name = typeof title === "string" && title.trim() ? title.trim() : monitor.name;
  return name.slice(0, MAX_PRODUCT_TITLE);
}

// Web push payloads are capped around 4KB once encrypted, and going over makes
// the send throw rather than truncate — the alert would vanish silently.
const MAX_PUSH_BODY = 500;
function truncateForPush(body: string): string {
  return body.length <= MAX_PUSH_BODY ? body : `${body.slice(0, MAX_PUSH_BODY - 1)}…`;
}

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
    // identities. The quick-check path diffs on candidateKeys instead.
    trackMatchKeys: v.optional(v.boolean()),
    // Every entry the keyword filter picked this check, judged or not.
    candidateKeys: v.optional(v.array(v.string())),
    // Entries judged on this check, verdict included. Kept apart from `items`,
    // which is the AI's model of the page and is what change detection diffs.
    scoredCandidates: v.optional(v.array(v.any())),
    // Whether this check went through the proxy — drives proxyPreferred.
    usedProxy: v.optional(v.boolean()),
    // The AI re-read the page on this check. Set even when the extract came
    // back too weak to use, because the call was still paid for.
    aiExtracted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor || (monitor.status !== "active" && monitor.status !== "error")) {
      return { parked: false, parkReason: null, newMatchKeys: [] as string[], resultId: null };
    }

    const now = Date.now();
    // Backfills rows older than the field on their next check, pass or fail,
    // so the known-host lookup in monitors.claimFirstScanProxy can see them.
    const hostStamp = monitor.host === undefined ? { host: displayHost(monitor.url) } : {};

    if (args.error) {
      const retryCount = (monitor.retryCount ?? 0) + 1;
      // Stamped on the failure path too: the AI was asked, whatever came back.
      // Without it a monitor whose extract always fails stays permanently past
      // its refresh deadline and re-attempts on every recovery check.
      const aiStamp = args.aiExtracted ? { lastAiExtractAt: now } : {};
      const proxyBlockCount = (monitor.proxyBlockCount ?? 0) + (args.confirmedProxyBlock ? 1 : 0);

      // Both parks stop rescheduling the same way: nextCheckAt: undefined sorts
      // before getMonitorsDue's .gte("nextCheckAt", 0) bound, so the monitor is
      // left alone until the user retries it by hand. They differ only in the
      // reason, which travels with the park so every channel tells one story.
      const parkReason =
        args.confirmedProxyBlock && proxyBlockCount >= MAX_PROXY_BLOCKS
          ? PARK_REASON_PROXY_BLOCKED
          // Never worked once, and has had long enough to. checkCount counts
          // successes only, so this cannot reach a monitor that has ever
          // returned a page — which is what makes it safe to decide on the
          // count alone, with no guess about why the checks are failing.
          : !monitor.checkCount && retryCount >= MAX_NEVER_SUCCEEDED_RETRIES
            ? PARK_REASON_NEVER_SUCCEEDED
            : null;

      if (parkReason) {
        await ctx.db.patch(args.monitorId, {
          status: "error",
          lastError: `Checks have stopped. ${parkReason} Use Retry to try again.`,
          retryCount,
          proxyBlockCount,
          nextCheckAt: undefined,
          updatedAt: now,
          ...aiStamp,
          ...hostStamp,
        });
        return { parked: true, parkReason, newMatchKeys: [] as string[], resultId: null };
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
          ...aiStamp,
          ...hostStamp,
        });
      } else {
        const backoffMs = Math.pow(4, retryCount) * 30_000;
        await ctx.db.patch(args.monitorId, {
          lastError: args.error,
          retryCount,
          proxyBlockCount,
          nextCheckAt: now + backoffMs,
          updatedAt: now,
          ...aiStamp,
          ...hostStamp,
        });
      }
      return { parked: false, parkReason: null, newMatchKeys: [] as string[], resultId: null };
    }

    // Remember whether this site needs the proxy at all. A direct success
    // clears the flag, which is also how the periodic re-probe takes effect.
    // Computed before the reschedule below, or the check that first flips a
    // site to proxy-preferred would still book itself an un-floored slot.
    const nextProxyPreferred =
      args.usedProxy === true
        ? isBlockedError(monitor.lastError ?? "") || monitor.proxyPreferred === true
        : args.usedProxy === false
          ? false
          : monitor.proxyPreferred;

    // Success
    const updates: Record<string, unknown> = {
      status: "active",
      matchCount: args.matchCount,
      checkCount: (monitor.checkCount ?? 0) + 1,
      retryCount: 0,
      proxyBlockCount: 0,
      lastCheckedAt: now,
      nextCheckAt: now + effectiveIntervalMs({
        checkInterval: monitor.checkInterval,
        proxyPreferred: nextProxyPreferred,
      }),
      updatedAt: now,
      lastError: undefined,
    };
    if (nextProxyPreferred !== monitor.proxyPreferred) {
      updates.proxyPreferred = nextProxyPreferred;
    }
    Object.assign(updates, hostStamp);

    // A successful first scan counts as a check, so a monitor reaching here
    // with none has either only ever failed (the first scan did not get in and
    // a retry just has) or is a listing in a product, which is first-scanned
    // here by design. Activation was never claimed for that user. The person
    // told "we'll keep trying" has heard nothing since, so they get an email.
    // A product's owner who could still be watching the scan in the app does
    // not; one whose listing only got in after retries does.
    // Anonymous monitors are outside this: their owner is an anon_ id with no
    // account to activate and no dashboard to send them to.
    if (!monitor.checkCount && !monitor.isAnonymous) {
      const watched = monitor.groupId !== undefined && now - monitor.createdAt < PRODUCT_SCAN_WATCHED_MS;
      const how = watched ? "got their first product read" : "got their first read after a failed first scan";
      await claimActivation(ctx, monitor, args.matchCount, how, false);
      // Same rule as the alerts: no list means every channel.
      const channels = monitor.notificationChannels;
      if (!watched && monitor.userEmail && !monitor.muted && (!channels || channels.includes("email"))) {
        await ctx.scheduler.runAfter(0, internal.emails.sendFirstReadAlert, {
          to: monitor.userEmail,
          userId: monitor.userId,
          monitorName: monitor.name,
          monitorId: monitor._id,
          url: monitor.url,
          matchCount: args.matchCount,
        });
      }
    }

    // Restart the drift clock whenever the AI read the page, whatever brought
    // it here and whatever came back. Stamping only on a usable schema would
    // leave a monitor that keeps extracting badly permanently past its
    // refresh deadline, re-extracting on every single check.
    if (args.aiExtracted) {
      updates.lastAiExtractAt = now;
    }

    // Keyed off new matches, not the running count. The count is "entries on
    // the page meeting your conditions", which stays non-zero for as long as
    // the listing is up — reading it as a fresh match reset "last match" to
    // now on every single check.
    if (args.hasNewMatches && !args.unchanged) {
      updates.lastMatchAt = now;
    }

    if (args.schema) {
      updates.schema = args.schema;
    }

    if (args.contentFingerprint) {
      updates.contentFingerprint = args.contentFingerprint;
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
    if (args.candidateKeys) {
      updates.candidateKeys = args.candidateKeys;
    }

    if (args.trackMatchKeys && (args.matches.length > 0 || args.totalItems > 0)) {
      const currentKeys = (args.matches as Record<string, unknown>[]).map(matchKey);
      newKeys = newMatchKeys(monitor.matchedKeys, currentKeys);
      updates.matchedKeys = [...new Set(currentKeys.filter(Boolean))];
    }

    await ctx.db.patch(args.monitorId, updates);

    // Unchanged page: monitor bookkeeping is done, skip the scrapeResults
    // insert — no new data to record and no changes to detect
    if (args.unchanged) return { parked: false, parkReason: null, newMatchKeys: [] as string[], resultId: null };

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

    const resultId = await ctx.db.insert("scrapeResults", {
      monitorId: args.monitorId,
      matches: args.matches,
      items: args.items,
      scoredCandidates: args.scoredCandidates,
      totalItems: args.totalItems,
      hasNewMatches: args.hasNewMatches,
      scrapedAt: now,
      changes,
    });

    return { parked: false, parkReason: null, newMatchKeys: newKeys, resultId };
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
    if (monitors.length >= MAX_CONCURRENT_CHECKS) {
      // Every slot filled means more was due than could be dispatched. Sustained,
      // it means real intervals are stretching past what the plan promises.
      console.warn(
        `[scheduler] dispatch saturated at ${MAX_CONCURRENT_CHECKS}/min — checks are running late`
      );
    }

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
            // Both paths now name the entries the user has not been told
            // about, so an alert means a genuinely new listing rather than a
            // page that merely still says what it said last time.
            const newCount = checkResult.newMatchKeys?.length ?? 0;

            // A listing in a product alerts only on its stock and price. Its
            // page often shows related items, and each would read as a match.
            if (newCount > 0 && freshMonitor.groupId === undefined) {
              // Only the items the user has not seen. On the quick-check path
              // there is nothing to narrow to, so this is the whole match set.
              const newKeys = new Set(checkResult.newMatchKeys ?? []);
              // Positions are kept because a feedback button carries an index
              // into the stored result row, not the entry itself — the filter
              // below would otherwise renumber them.
              const newWithIndex = (checkResult.matches as Record<string, unknown>[])
                .map((m, index) => ({ m, index }))
                .filter(({ m }) => newKeys.has(matchKey(m)));
              const newMatches = newWithIndex.map(({ m }) => m);
              const plural = newCount !== 1 ? "es" : "";
              const base = {
                monitorName: freshMonitor.name,
                monitorId: freshMonitor._id,
                url: freshMonitor.url,
                matchCount: newCount,
                totalItems: displayTotalItems,
              };

              await ctx.scheduler.runAfter(0, internal.admin.notify, {
                text: `Match: ${freshMonitor.name} found ${newCount} new on ${displayHost(freshMonitor.url)} (${freshMonitor.userEmail ?? "no email"})`,
              });

              await deliverAlert(ctx, freshMonitor, {
                type: "match",
                title: `${freshMonitor.name} — ${newCount} new match${plural}`,
                inAppMessage: `Found ${newCount} new match${plural} out of ${displayTotalItems} items on ${freshMonitor.url}`,
                pushBody: `${newCount} new match${plural} out of ${displayTotalItems} items on ${displayHost(freshMonitor.url)}`,
                email: (to) => ctx.runAction(internal.emails.sendMatchAlert, { ...base, to, matches: newMatches }),
                telegram: (chatId) =>
                  ctx.runAction(internal.telegram.sendMatchAlert, {
                    ...base,
                    chatId,
                    matches: newWithIndex.slice(0, TELEGRAM_ALERT_ITEMS).map(({ m, index }) => ({
                      index,
                      title: String(m.title ?? m.name ?? "Item"),
                      matchScore: typeof m.matchScore === "number" ? m.matchScore : undefined,
                    })),
                    resultId: checkResult.resultId ?? undefined,
                  }),
                discord: (webhookUrl) => ctx.runAction(internal.discord.sendMatchAlert, { ...base, webhookUrl }),
                sms: (phone) =>
                  ctx.runAction(internal.sms.sendMatchAlert, {
                    userId: freshMonitor.userId,
                    phone,
                    monitorName: freshMonitor.name,
                    monitorId: freshMonitor._id,
                    matchCount: newCount,
                  }),
              });
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
          // A monitor that flaps back into error within a week still gets its
          // in-app notice, which costs nothing and keeps a record of the
          // outage, but nothing that lands in an inbox or on a phone.
          const errorAlertCoolingDown =
            Date.now() - (monitor.lastErrorAlertAt ?? 0) < ERROR_ALERT_COOLDOWN_MS;

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
          const parkReason = outcome?.parkReason ?? null;

          // Re-fetch for fresh muted/channel state
          if (parked || willError) {
            const freshErrMonitor = await ctx.runQuery(internal.monitors.getInternal, { id: monitor._id });
            if (freshErrMonitor && !freshErrMonitor.muted) {
              const coolingDown = !parked && errorAlertCoolingDown;
              const channels = alertChannels(freshErrMonitor.notificationChannels);
              const hasAnyChannel = channels.hasAnyChannel;

              // Looked up before the sends so the email knows whether to nudge
              // the user towards Telegram. Not gated on shouldSend: a user who
              // already has Telegram must not be told to go connect it.
              const telegramSetting = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
                userId: freshErrMonitor.userId,
                channel: "telegram",
              });
              const telegramConnected = !!(telegramSetting?.enabled && telegramSetting.target);

              // A product's listings tend to fail together, when the fault is
              // ours or the network's. The product sends one error alert for
              // them, claimed only by a listing that can deliver it. A park is
              // final, so each listing still sends its own.
              const canDeliver =
                (channels.shouldSend("email") && !!freshErrMonitor.userEmail) ||
                channels.shouldSend("push") ||
                (channels.shouldSend("telegram") && telegramConnected) ||
                channels.shouldSend("discord");
              const productName =
                freshErrMonitor.groupId !== undefined && !parked && !coolingDown && canDeliver
                  ? await ctx.runMutation(internal.monitorGroups.claimErrorAlert, { id: freshErrMonitor.groupId })
                  : null;
              const quiet = coolingDown || (freshErrMonitor.groupId !== undefined && !parked && productName === null);
              const alertName = productName
                ? `${productName} on ${displayHost(freshErrMonitor.url)}`
                : freshErrMonitor.name;
              const shouldSend = (channel: string) => !quiet && channels.shouldSend(channel);

              if (!parked && !quiet) {
                await ctx.runMutation(internal.scheduler.markErrorAlertSent, {
                  monitorId: freshErrMonitor._id,
                }).catch(() => {});
              }

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
                  title: `${alertName} — ${parked ? "Checks stopped" : "Error"}`,
                  body: truncateForPush(parked ? (freshErrMonitor.lastError ?? msg) : msg),
                  kind: "error",
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
                    monitorName: alertName,
                    monitorId: freshErrMonitor._id,
                    url: freshErrMonitor.url,
                    reason: parkReason ?? PARK_REASON_PROXY_BLOCKED,
                    telegramConnected,
                  }).catch(() => {});
                } else {
                  await ctx.runAction(internal.emails.sendErrorAlert, {
                    to: freshErrMonitor.userEmail,
                    monitorName: alertName,
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
                    monitorName: alertName,
                    monitorId: freshErrMonitor._id,
                    url: freshErrMonitor.url,
                    reason: parkReason ?? PARK_REASON_PROXY_BLOCKED,
                  }).catch(() => {});
                } else {
                  await ctx.runAction(internal.telegram.sendErrorAlert, {
                    chatId: telegramSetting.target,
                    monitorName: alertName,
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
                      monitorName: alertName,
                      monitorId: freshErrMonitor._id,
                      url: freshErrMonitor.url,
                      reason: parkReason ?? PARK_REASON_PROXY_BLOCKED,
                    }).catch(() => {});
                  } else {
                    await ctx.runAction(internal.discord.sendErrorAlert, {
                      webhookUrl: discordSetting.target,
                      monitorName: alertName,
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

/** One listing entry the scraper's keyword filter picked out of the page. */
type QuickCheckCandidate = {
  title: string;
  url: string | null;
  price: number | null;
  snippet: string;
};

type ScoredCandidate = QuickCheckCandidate & {
  /** Null means the judgement never came back — distinct from having scored badly. */
  matchScore: number | null;
  matchReason: string;
  /** Only when stock was asked for. Price is in minor units. */
  stock?: { inStock: boolean | null; price: number | null; currency: string | null };
};

/** Entries judged in one check. The rest keep their place in the seen set and wait their turn. */
const MAX_SCORED_PER_CHECK = 25;

/**
 * Entries named individually in a Telegram alert. Each one carries its own
 * pair of feedback buttons, and a keyboard taller than this stops being
 * something anyone reads on a phone.
 */
const TELEGRAM_ALERT_ITEMS = 3;

type CheckOutcome = {
  hasMatch: boolean;
  matchCount: number;
  matches: unknown[];
  totalItems: number | null;
  strategy: string;
  /** Matched entries the user has not been told about. Both check paths supply it. */
  newMatchKeys?: string[];
  /** The stored result row these matches live in — what a feedback button points at. */
  resultId?: string | null;
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

  // A stale schema may describe another page (the URL was edited), so its
  // product title cannot be trusted until the drift refresh below re-reads it.
  const readsProduct = wantsProductRead(monitor) && !shouldEscalateToAI(monitor);

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
      ...(readsProduct ? { productTitle: productTitle(monitor) } : {}),
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

  // The product's entry went into the seen set on the first check and is
  // never judged again below, so a restock would go unseen. Re-read it
  // whenever its own text changes. Placed before the unchanged short-circuit
  // so a monitor that has just switched an alert on takes its baseline
  // even on a page that has not moved.
  if (readsProduct && result.product && result.product.hash !== monitor.productFingerprint) {
    if (result.product.matched === false) {
      console.warn(`[scheduler] Quick check ${monitor._id}: product title not on the page, reading on any page change`);
    }
    await readProduct(ctx, monitor, result.product, scraperUrl, scraperKey);
  }

  // Cheap short-circuit: content identical to the last scan — record the
  // check happened and stop. No result row, no match notifications.
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

  // A scraper still answering the previous response shape — this Convex
  // deploy landing before the scraper's. Reading that as "no entries match"
  // would blank the seen set, and every listing on the page would then read
  // as a new arrival the moment the scraper caught up, alerting on all of
  // them. Record the check and change nothing.
  if (!Array.isArray(result.candidates)) {
    console.error(`[scheduler] Quick check ${monitor._id}: scraper returned no candidates field — deploy the scraper before Convex`);
    await ctx.runMutation(internal.scheduler.recordCheckResult, {
      monitorId: monitor._id,
      hasNewMatches: false,
      matchCount: monitor.matchCount ?? 0,
      totalItems: 0,
      matches: [],
      unchanged: true,
      usedProxy: useProxy,
    });
    return { hasMatch: false, matchCount: monitor.matchCount ?? 0, matches: [], totalItems: null, strategy: "awaiting-scraper" };
  }

  // Entries the keyword filter picked, each one a single listing rather than
  // the whole page. See matchPageSegments in @prowl/shared.
  const candidates = result.candidates as QuickCheckCandidate[];
  const totalEntries = typeof result.totalEntries === "number" ? result.totalEntries : candidates.length;
  const blacklist = (monitor.blacklistedItems ?? []) as string[];
  const visible = dedupeByKey(filterBlacklisted(candidates, blacklist));

  const candidateKeys = visible.map(matchKey).filter(Boolean);
  // Entries already seen last check are not worth judging again, whatever the
  // verdict was. Seeding on a monitor with no baseline returns nothing, so
  // this shipping does not alert anyone about listings already on the page.
  const unseenKeys = new Set(newMatchKeys(monitor.candidateKeys, candidateKeys));
  const unseen = visible
    .filter((c) => unseenKeys.has(matchKey(c)))
    .slice(0, MAX_SCORED_PER_CHECK);

  // New entries past the per-check cap stay out of the seen set so the next
  // check picks them up. Recording them as seen alongside the ones actually
  // judged would drop them silently and for good.
  const judged = new Set(unseen.map(matchKey));
  const seenAfterCheck = candidateKeys.filter((k) => !unseenKeys.has(k) || judged.has(k));

  if (unseen.length === 0) {
    await ctx.runMutation(internal.scheduler.recordCheckResult, {
      monitorId: monitor._id,
      hasNewMatches: false,
      matchCount: visible.length,
      totalItems: totalEntries,
      matches: [],
      contentFingerprint: contentHash,
      candidateKeys: seenAfterCheck,
      usedProxy: useProxy,
    });
    console.log(`[scheduler] Quick check ${monitor._id}: ${visible.length} candidate(s), none new`);
    return { hasMatch: false, matchCount: visible.length, matches: [], totalItems: totalEntries, strategy: "quick-check", newMatchKeys: [] };
  }

  // Only the new entries reach the AI, and only their own text does. A page
  // that has not changed, or whose changes are all old news, costs nothing.
  const scored = await scoreQuickCheckCandidates(unseen, monitor, scraperUrl, scraperKey);
  const matches = scored.filter((c) => alertsOnScore(c.matchScore));

  const outcome = await ctx.runMutation(internal.scheduler.recordCheckResult, {
    monitorId: monitor._id,
    hasNewMatches: matches.length > 0,
    matchCount: visible.length,
    totalItems: totalEntries,
    matches,
    // Deliberately not `items`: that field is the AI's model of the whole
    // page, and change detection diffs it against the previous check. Handing
    // it this check's handful of new entries would read as the rest of the
    // page having been removed.
    scoredCandidates: scored,
    contentFingerprint: contentHash,
    candidateKeys: seenAfterCheck,
    usedProxy: useProxy,
  });

  console.log(
    `[scheduler] Quick check ${monitor._id}: ${visible.length} candidate(s), ${unseen.length} new, ${matches.length} above threshold`
  );

  return {
    hasMatch: matches.length > 0,
    matchCount: visible.length,
    matches,
    totalItems: totalEntries,
    strategy: "quick-check",
    newMatchKeys: matches.map(matchKey),
    resultId: outcome?.resultId ?? null,
  };
}

/**
 * Ask the scraper to judge entries against the user's own words.
 *
 * A scoring failure must not silence a monitor, so entries come back with a
 * null score, which the caller lets through. The keyword filter already
 * vouched for them; the judgement narrows further, it does not grant the
 * match.
 */
async function scoreQuickCheckCandidates(
  candidates: QuickCheckCandidate[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monitor: any,
  scraperUrl: string,
  scraperKey: string,
  readStock = false
): Promise<ScoredCandidate[]> {
  const unscored: ScoredCandidate[] = candidates.map((c) => ({ ...c, matchScore: null, matchReason: "" }));
  try {
    const res = await fetch(`${scraperUrl}/api/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": scraperKey },
      body: JSON.stringify({
        prompt: monitor.prompt,
        name: monitor.name,
        userId: monitor.userId,
        candidates,
        ...(readStock ? { readStock: true } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.warn(`[scheduler] Scoring failed for ${monitor._id} (${res.status}) — alerting unscored`);
      return unscored;
    }
    const body = await res.json();
    return Array.isArray(body.scored) && body.scored.length === candidates.length
      ? (body.scored as ScoredCandidate[])
      : unscored;
  } catch (e) {
    console.warn(`[scheduler] Scoring errored for ${monitor._id}: ${(e as Error).message} — alerting unscored`);
    return unscored;
  }
}

/**
 * Read stock and price for a single-product monitor's one product.
 *
 * A failed read still stores the fingerprint, as an unknown reading, so the
 * next attempt waits for the next change. Retrying on every check instead
 * would bill a call per check for as long as the failure lasts. The cost is
 * that a restock landing on a failed read is only seen on the next change.
 */
async function readProduct(
  ctx: Pick<ActionCtx, "runMutation">,
  monitor: Doc<"monitors">,
  product: { excerpt: string; hash: string },
  scraperUrl: string,
  scraperKey: string
): Promise<void> {
  const [scored] = await scoreQuickCheckCandidates(
    [{ title: productTitle(monitor), url: monitor.url, price: null, snippet: product.excerpt }],
    monitor,
    scraperUrl,
    scraperKey,
    true
  );
  if (!scored?.stock) {
    console.warn(`[scheduler] Product read for ${monitor._id} came back without stock — retrying on the next change`);
  }
  await ctx.runMutation(internal.scheduler.recordProductRead, {
    monitorId: monitor._id,
    url: monitor.url,
    productFingerprint: product.hash,
    ...(scored?.stock ?? { inStock: null, price: null, currency: null }),
  });
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
      userId: monitor.userId,
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
  const filteredMatches = dedupeByKey(filterBlacklisted(allMatches as Record<string, unknown>[], blacklist));
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
    resultId: outcome?.resultId ?? null,
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
    channel: v.union(v.literal("email"), v.literal("telegram"), v.literal("discord"), v.literal("sms")),
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

const productAlertValidator = v.union(
  v.object({ kind: v.literal("stock") }),
  v.object({
    kind: v.literal("price"),
    reason: v.union(v.literal("drop"), v.literal("below")),
    // Absent when a target is already met on the first read.
    oldPrice: v.optional(v.number()),
    newPrice: v.number(),
    currency: v.string(),
    target: v.optional(v.number()),
  }),
);
type ProductAlert = Infer<typeof productAlertValidator>;

/**
 * Store a product read and decide whether it is news.
 *
 * Stock alerts only on a known out of stock followed by a known in stock.
 * Price alerts compare against the last known price, and a read in another
 * currency is ignored:
 * "any drop" on any fall, "below a target" when the price is at or below
 * the target and was not last time, so it does not repeat while it stays
 * low. A target already met on the first read alerts once.
 *
 * Otherwise no baseline never alerts, so switching an option on cannot fire
 * straight away. An unreadable value keeps the last known one. Scheduling the send
 * here ties it to the write: a check that fails after this point cannot
 * lose the alert.
 */
export const recordProductRead = internalMutation({
  args: {
    monitorId: v.id("monitors"),
    // The URL the read was taken from. A read that finishes after the URL
    // was edited describes the old page and is dropped.
    url: v.string(),
    productFingerprint: v.string(),
    inStock: v.union(v.boolean(), v.null()),
    price: v.union(v.number(), v.null()),
    currency: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor || monitor.url !== args.url) return { alerts: [] as ProductAlert[] };

    const previous = monitor.lastSeen ?? {};
    const on = monitor.alertOn ?? {};
    const alerts: ProductAlert[] = [];

    if (on.backInStock === true && previous.inStock === false && args.inStock === true) {
      alerts.push({ kind: "stock" });
    }

    // Kept as they are unless this read has a usable price. A held price is
    // dropped: this read was its one chance to be confirmed.
    let priceFields: { price?: number; currency?: string; pendingPrice?: number } =
      previous.price !== undefined && previous.currency !== undefined
        ? { price: previous.price, currency: previous.currency }
        : {};
    if (args.price !== null && args.currency !== null && previous.currency !== undefined && previous.currency !== args.currency) {
      // Usually a misread or a geo-priced page. Taken as the baseline, it would
      // make the next read in the usual currency look like a first read, and
      // alert again about a price the user has already heard about.
      console.warn(`[scheduler] ${monitor._id}: price read in ${args.currency}, not ${previous.currency}; keeping the last price`);
    } else if (args.price !== null && args.currency !== null) {
      const newPrice = args.price;
      const currency = args.currency;
      const oldPrice = previous.currency === currency ? previous.price : undefined;
      // A fall of more than half is more often a misread (a monthly payment,
      // a deposit, an accessory's price) than a sale. It waits for the same
      // price on the next read before it counts. Only one read is held, so a
      // second wild price is dropped rather than held again.
      const unconfirmed = oldPrice !== undefined && newPrice < oldPrice / 2 && previous.pendingPrice !== newPrice;
      if (unconfirmed) {
        if (previous.pendingPrice === undefined) priceFields = { price: oldPrice, currency, pendingPrice: newPrice };
      } else {
        priceFields = { price: newPrice, currency };
        const price = { kind: "price" as const, oldPrice, newPrice, currency };
        const target = on.priceBelow;
        if (on.priceDrop === true && oldPrice !== undefined && newPrice < oldPrice) {
          alerts.push({ ...price, reason: "drop" });
        } else if (target && target.currency !== currency) {
          console.warn(`[scheduler] ${monitor._id}: target is in ${target.currency} but the price read in ${currency}, not compared`);
        } else if (target && newPrice <= target.amount && (oldPrice === undefined || oldPrice > target.amount)) {
          alerts.push({ ...price, reason: "below", target: target.amount });
        }
      }
    }

    const inStock = args.inStock ?? previous.inStock;
    await ctx.db.patch(args.monitorId, {
      // A newly held price needs a second read. Keeping the old fingerprint
      // makes the next check read again, even if the page has not changed.
      // Every other read advances it, so a failed confirmation is not
      // retried, and paid for, on every check.
      productFingerprint: priceFields.pendingPrice !== undefined ? monitor.productFingerprint : args.productFingerprint,
      lastSeen: { ...(inStock !== undefined ? { inStock } : {}), ...priceFields },
    });

    for (const alert of alerts) {
      await ctx.scheduler.runAfter(0, internal.scheduler.sendProductAlert, { monitorId: args.monitorId, alert });
    }
    return { alerts };
  },
});

function money(minor: number, currency: string): string {
  return formatMinorUnits(minor, currency) ?? `${minor} ${currency}`;
}

/** Long enough to recognise; short enough that the price and site always fit in a push or a Telegram line. */
const MAX_TITLE_IN_MESSAGE = 120;

/** The wording of one alert: a headline, one sentence, and the news for an SMS. */
function productAlertText(alert: ProductAlert, fullTitle: string, host: string) {
  const title = fullTitle.length > MAX_TITLE_IN_MESSAGE ? `${fullTitle.slice(0, MAX_TITLE_IN_MESSAGE - 1)}…` : fullTitle;
  if (alert.kind === "stock") {
    return { headline: "Back in stock", message: `${title} is back in stock on ${host}.`, what: "back in stock" };
  }
  const now = money(alert.newPrice, alert.currency);
  const nowForSms = formatSmsPrice(alert.newPrice, alert.currency);
  const was = alert.oldPrice !== undefined ? money(alert.oldPrice, alert.currency) : null;
  if (alert.reason === "below" && alert.target !== undefined) {
    return {
      headline: "Below your target price",
      message: `${title} is now ${now} on ${host}, below your ${money(alert.target, alert.currency)} target.${was ? ` It was ${was}.` : ""}`,
      what: `now ${nowForSms}, below your target`,
    };
  }
  return { headline: "Price drop", message: `${title} is now ${now} on ${host}, down from ${was}.`, what: `price drop to ${nowForSms}` };
}

/** Tell the owner about a stock or price change, on the same channels a match alert uses. */
export const sendProductAlert = internalAction({
  args: { monitorId: v.id("monitors"), alert: productAlertValidator },
  handler: async (ctx, args) => {
    const monitor = await ctx.runQuery(internal.monitors.getInternal, { id: args.monitorId });
    if (!monitor || monitor.muted) return;

    const title = productTitle(monitor);
    const host = displayHost(monitor.url);
    const { headline, message, what } = productAlertText(args.alert, title, host);
    const kind = args.alert.kind;
    const base = { monitorId: monitor._id, url: monitor.url, headline, message };

    await ctx.scheduler.runAfter(0, internal.admin.notify, {
      text: `${headline}: ${monitor.name} on ${host} (${monitor.userEmail ?? "no email"})`,
    });

    await deliverAlert(ctx, monitor, {
      type: kind,
      title: `${monitor.name} — ${headline.toLowerCase()}`,
      inAppMessage: message,
      pushBody: truncateForPush(message),
      email: (to) =>
        ctx.runAction(internal.emails.sendProductAlert, { ...base, to, kind, monitorName: monitor.name, productTitle: title }),
      telegram: (chatId) => ctx.runAction(internal.telegram.sendProductAlert, { ...base, chatId }),
      discord: (webhookUrl) => ctx.runAction(internal.discord.sendProductAlert, { ...base, webhookUrl }),
      sms: (phone) =>
        ctx.runAction(internal.sms.sendProductAlert, {
          userId: monitor.userId,
          phone,
          monitorId: monitor._id,
          what,
          productTitle: title,
        }),
    });
  },
});

export const markErrorAlertSent = internalMutation({
  args: { monitorId: v.id("monitors") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.monitorId, { lastErrorAlertAt: Date.now() });
  },
});

