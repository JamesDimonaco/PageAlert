import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { intervalToMs, MAX_RETRIES } from "./shared";

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

    await ctx.db.insert("scrapeResults", {
      monitorId: args.monitorId,
      matches: args.matches,
      totalItems: args.totalItems,
      hasNewMatches: args.hasNewMatches,
      scrapedAt: now,
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

          let checkResult: { hasMatch: boolean; matchCount: number; matches: unknown[] };

          if (needsReextract && monitor.schema) {
            checkResult = await runFullExtract(ctx, monitor, scraperUrl, scraperKey);
          } else {
            checkResult = await runQuickCheck(ctx, monitor, scraperUrl, scraperKey);
          }

          // Send email notification if there are matches and user has an email
          if (checkResult.hasMatch && monitor.userEmail) {
            await ctx.runAction(internal.emails.sendMatchAlert, {
              to: monitor.userEmail,
              monitorName: monitor.name,
              monitorId: monitor._id,
              url: monitor.url,
              matchCount: checkResult.matchCount,
              matches: checkResult.matches,
              totalItems: 0,
            });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          console.error(`[scheduler] Monitor ${monitor._id} failed:`, msg);

          await ctx.runMutation(internal.scheduler.recordCheckResult, {
            monitorId: monitor._id,
            hasNewMatches: false,
            matchCount: 0,
            totalItems: 0,
            matches: [],
            error: msg,
          });
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
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  monitor: any,
  scraperUrl: string,
  scraperKey: string
): Promise<{ hasMatch: boolean; matchCount: number; matches: unknown[] }> {
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
    matchCount: hasMatch ? (monitor.matchCount ?? 0) + 1 : monitor.matchCount ?? 0,
    totalItems: 0,
    matches: hasMatch
      ? [{ quickCheck: true, keywordResults: result.keywordResults, priceResults: result.priceResults }]
      : [],
  });

  console.log(`[scheduler] Quick check ${monitor._id}: ${hasMatch ? "MATCH" : "no match"}`);

  const matchData = hasMatch
    ? [{ quickCheck: true, keywordResults: result.keywordResults, priceResults: result.priceResults }]
    : [];
  return { hasMatch, matchCount: hasMatch ? 1 : 0, matches: matchData };
}

async function runFullExtract(
  ctx: { runMutation: (ref: any, args: any) => Promise<any>; runAction: (ref: any, args: any) => Promise<any> },
  monitor: any,
  scraperUrl: string,
  scraperKey: string
): Promise<{ hasMatch: boolean; matchCount: number; matches: unknown[] }> {
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
      console.log(`[scheduler] Skipping re-extract for ${monitor._id}: page inaccessible`);
      await ctx.runMutation(internal.scheduler.recordCheckResult, {
        monitorId: monitor._id,
        hasNewMatches: false,
        matchCount: monitor.matchCount ?? 0,
        totalItems: 0,
        matches: [],
        error: "Page inaccessible during re-extract — kept existing schema",
      });
      return { hasMatch: false, matchCount: 0, matches: [] };
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
    console.log(`[scheduler] Re-extract ${monitor._id}: low confidence (${confidence}%), keeping existing schema`);
    await ctx.runMutation(internal.scheduler.recordCheckResult, {
      monitorId: monitor._id,
      hasNewMatches: false,
      matchCount: monitor.matchCount ?? 0,
      totalItems: 0,
      matches: [],
      error: `Re-extract low confidence (${confidence}%) — kept existing schema`,
    });
    return { hasMatch: false, matchCount: 0, matches: [] };
  }

  const matchCount = result.matches?.length ?? 0;
  const totalItems = result.totalItems ?? 0;

  await ctx.runMutation(internal.scheduler.recordCheckResult, {
    monitorId: monitor._id,
    hasNewMatches: matchCount > 0,
    matchCount,
    totalItems,
    matches: result.matches ?? [],
    schema: result.schema,
  });

  console.log(`[scheduler] Full re-extract ${monitor._id}: ${totalItems} items, ${matchCount} matches`);

  return { hasMatch: matchCount > 0, matchCount, matches: result.matches ?? [] };
}
