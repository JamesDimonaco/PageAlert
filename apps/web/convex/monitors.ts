import { ConvexError, v, type Infer, type ObjectType } from "convex/values";
import { mutation, query, internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { displayHost, effectiveIntervalMs, ERROR_RECOVERY_INTERVAL_MS, intervalToMs, isBlockedError, MAX_RETRIES, soldOutKeysOf, validateMonitorUrl } from "./shared";
import { currencyExponent, itemIdentity, RESUME_TOKEN_TTL_MS, stockNotShownNote, type ExtractedItem, type MatchConditions } from "@prowl/shared";
import { effectiveTier, type Tier } from "./tiers";
import { drain, isBanned, requireLiveAccount, spent, SWEEP_BUDGET_BYTES, SWEEP_BUDGET_ROWS, type Allowance } from "./account";
import { reserveFallback, scraperDown } from "./admin";
import { deliverAlert } from "./alerts";
import { alertOnValidator, checkIntervalValidator, notificationChannelsValidator, type CheckInterval } from "./schema";

// ---- Resource Limits ----
const MAX_NAME_LENGTH = 200;
const MAX_PROMPT_LENGTH = 2000;
const MAX_RESULTS_LIMIT = 100;

const TIER_LIMITS: Record<Tier, { maxMonitors: number; allowedIntervals: string[] }> = {
  free: { maxMonitors: 3, allowedIntervals: ["1h", "6h", "24h"] },
  sprint: { maxMonitors: 10, allowedIntervals: ["30m", "1h", "6h", "24h"] },
  pro: { maxMonitors: 25, allowedIntervals: ["15m", "30m", "1h", "6h", "24h"] },
  max: { maxMonitors: 9999, allowedIntervals: ["5m", "15m", "30m", "1h", "6h", "24h"] },
};

// Monitor creations allowed per rolling window — creation triggers a paid
// one-time AI extraction, and creations are counted even after deletion
const CREATION_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
const CREATION_LIMITS: Record<Tier, number> = {
  free: 3,
  sprint: 10,
  pro: 20,
  max: 100,
};

async function getUserTier(ctx: { db: any }, userId: string): Promise<Tier> {
  const record = await ctx.db
    .query("userTiers")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .unique();
  return effectiveTier(record);
}

/** A free monitor's channels. A list that was only texts falls back to email rather than alerting nobody. */
function withoutSms<C extends string>(channels: C[]): C[] {
  const rest = channels.filter((c) => c !== "sms");
  return rest.length > 0 ? rest : (["email"] as C[]);
}

export function clampInterval(interval: string, tier: Tier): CheckInterval {
  const allowed = TIER_LIMITS[tier].allowedIntervals;
  return (allowed.includes(interval) ? interval : allowed[0]) as CheckInterval;
}

/** What a user's plan allows, read once per mutation however many monitors it changes. */
export type Plan = { tier: Tier };

export async function readPlan(ctx: MutationCtx, userId: string): Promise<Plan> {
  if (await isBanned(ctx, userId)) throw new ConvexError("This account has been suspended.");
  return { tier: await getUserTier(ctx, userId) };
}

/**
 * The channels a monitor may use. Every plan gets email, push, Telegram and
 * Discord on every monitor: none of them costs us anything per message.
 * Texts do, so free has none.
 */
export function allowedChannels(plan: Plan, channels: ChannelList): ChannelList {
  return plan.tier === "free" ? withoutSms(channels) : channels;
}

// Formats a millisecond duration as a human-readable wait time, rounding
// minutes up so we never tell the user a too-short wait.
function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${minutes}m`;
}

async function getAuthUserId(ctx: { auth: { getUserIdentity: () => Promise<{ subject: string } | null> } }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity.subject;
}


function validateName(name: string): void {
  if (name.length === 0) throw new ConvexError("Name is required");
  if (name.length > MAX_NAME_LENGTH) throw new ConvexError(`Name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
}

function validatePrompt(prompt: string): void {
  if (prompt.length === 0) throw new ConvexError("Prompt is required");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new ConvexError(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
}

export function validateAlertOn(alertOn: Infer<typeof alertOnValidator>): void {
  if (alertOn.priceDrop && alertOn.priceBelow !== undefined) {
    throw new ConvexError("Pick any price drop or a target price, not both.");
  }
  const target = alertOn.priceBelow;
  if (
    target !== undefined &&
    (!Number.isInteger(target.amount) || target.amount <= 0 || currencyExponent(target.currency) === null)
  ) {
    throw new ConvexError("The target price must be above zero, in a real currency.");
  }
}

const statusValidator = v.union(
  v.literal("scanning"),
  v.literal("active"),
  v.literal("paused"),
  v.literal("error")
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
    // Strip the heavy schema field — the dashboard only needs metadata, not the
    // full extraction data — and the restart token, which is a bearer
    // credential for an unauthenticated mutation and belongs in the pause email
    // and nowhere else. The detail page uses `get`, which strips the same.
    return monitors.map(({ schema, resumeToken, ...rest }) => {
      void schema;
      void resumeToken;
      return rest;
    });
  },
});

export const get = query({
  args: { id: v.id("monitors") },
  handler: async (ctx, { id }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const monitor = await ctx.db.get(id);
    if (!monitor || monitor.userId !== identity.subject) return null;
    // The restart token belongs in the pause email and nowhere else — the
    // dashboard has the Resume button and does not need it.
    const { resumeToken, ...rest } = monitor;
    void resumeToken;
    return rest;
  },
});

/**
 * The creation rate limit as the client needs it: the limit, its window, and
 * when the user's latest creations were. The client counts those inside the
 * window with its own clock, because a query can't read one.
 */
export const creationAllowance = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const limit = CREATION_LIMITS[await getUserTier(ctx, identity.subject)];
    const recent = await ctx.db
      .query("monitorCreations")
      .withIndex("by_userId_createdAt", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(limit);
    return { limit, windowMs: CREATION_WINDOW_MS, recent: recent.map((c) => c.createdAt) };
  },
});

// ---- Mutations ----

type ChannelList = Infer<typeof notificationChannelsValidator>;
const ALL_CHANNELS: ChannelList = notificationChannelsValidator.element.members.map((m) => m.value);

/**
 * Create a monitor in "scanning" state for this user. The caller runs the
 * first scan and then calls saveScanResultForUser or saveScanErrorForUser:
 * the web app from the browser, the MCP route from the server.
 */
export async function createMonitorForUser(
  ctx: MutationCtx,
  { userId, userEmail }: { userId: string; userEmail: string | undefined },
  args: {
    name: string;
    url: string;
    prompt: string;
    checkInterval: CheckInterval;
    notificationChannels?: ChannelList;
    /** The product this monitor watches a listing of. */
    groupId?: Id<"monitorGroups">;
    alertOn?: Infer<typeof alertOnValidator>;
  }
): Promise<Id<"monitors">> {
  if (await isBanned(ctx, userId)) throw new ConvexError("This account has been suspended.");
  // A token outlives the account it was minted for; see requireLiveAccount.
  await requireLiveAccount(ctx, userId);

  // Dynamic tier-based enforcement
  const tier = await getUserTier(ctx, userId);
  const limits = TIER_LIMITS[tier];
  const checkInterval = clampInterval(args.checkInterval, tier);

  validateName(args.name);
  validateMonitorUrl(args.url);
  validatePrompt(args.prompt);
  if (args.alertOn) validateAlertOn(args.alertOn);

  // Rolling-window creation rate limit — counts survive deletion so
  // delete-and-remake can't bypass the paid AI extraction limit
  const windowStart = Date.now() - CREATION_WINDOW_MS;
  const recentCreations = await ctx.db
    .query("monitorCreations")
    .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId).gt("createdAt", windowStart))
    .collect();
  if (recentCreations.length >= CREATION_LIMITS[tier]) {
    const oldestCreatedAt = Math.min(...recentCreations.map((c) => c.createdAt));
    const wait = formatWait(oldestCreatedAt + CREATION_WINDOW_MS - Date.now());
    throw new ConvexError(`Creation limit reached: your ${tier} plan allows ${CREATION_LIMITS[tier]} new monitors per 5 hours. You can create another in ${wait}.`);
  }

  const existingMonitors = await ctx.db
    .query("monitors")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  if (existingMonitors.length >= limits.maxMonitors) {
    throw new ConvexError(`Your ${tier} plan allows ${limits.maxMonitors} monitors. Upgrade for more.`);
  }

  // No list means every channel, texts included, so on free it becomes an
  // explicit list without them. The web form always sends a list; MCP leaves it out.
  const channels =
    tier === "free" ? allowedChannels({ tier }, args.notificationChannels ?? ALL_CHANNELS) : args.notificationChannels;

  const now = Date.now();
  const id = await ctx.db.insert("monitors", {
    name: args.name.trim(),
    url: args.url.trim(),
    host: displayHost(args.url.trim()),
    prompt: args.prompt.trim(),
    checkInterval: checkInterval,
    notificationChannels: channels,
    groupId: args.groupId,
    alertOn: args.alertOn,
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

  await ctx.db.insert("monitorCreations", { userId, createdAt: now });

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
}

export const create = mutation({
  args: {
    name: v.string(),
    url: v.string(),
    prompt: v.string(),
    checkInterval: checkIntervalValidator,
    notificationChannels: v.optional(notificationChannelsValidator),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    return createMonitorForUser(ctx, { userId: identity.subject, userEmail: identity.email ?? undefined }, args);
  },
});

/**
 * Save scan results to a monitor. Transitions from "scanning" to "active".
 *
 * `matches` is the matched items. Without it, the history row falls back to
 * every item on the page, which is what the web flow sent before it had them.
 */
export async function saveScanResultForUser(
  ctx: MutationCtx,
  userId: string,
  {
    id,
    schema,
    matchCount,
    contentFingerprint,
    matches,
  }: {
    id: Id<"monitors">;
    // The extractor's schema, stored as-is; its shape is the scraper's to define.
    schema: unknown;
    matchCount: number;
    contentFingerprint?: string;
    matches?: unknown[];
  }
): Promise<void> {
  const monitor = await ctx.db.get(id);
  if (!monitor || monitor.userId !== userId) throw new Error("Monitor not found");
  if (monitor.status !== "scanning") return;

  const now = Date.now();
  await ctx.db.patch(id, {
    schema,
    contentFingerprint,
    status: "active",
    matchCount,
    checkCount: (monitor.checkCount ?? 0) + 1,
    retryCount: 0,
    proxyBlockCount: 0,
    // proxyPreferred is left to the scheduler even when this page came
    // through the proxy. Nothing server-side records which attempt got in,
    // and it is fleet-wide evidence other users' first scans spend credit on,
    // so it must not rest on what the browser says.
    lastCheckedAt: now,
    lastMatchAt: matchCount > 0 ? now : undefined,
    lastAiExtractAt: now,
    nextCheckAt: now + effectiveIntervalMs(monitor),
    // A scan reports its own matches to the user. Drop the baseline so the next scheduled extract
    // re-seeds it silently rather than re-announcing what the scan just
    // showed. The cost is the other half of that trade: anything appearing
    // between the scan and that extract goes unannounced.
    matchedKeys: undefined,
    // A rescan keeps what quick checks queued: those entries are still seen.
    soldOutKeys: soldOutKeysOf(schema, monitor.soldOutKeys),
    updatedAt: now,
  });

  // Save initial scan to history so it appears in the History tab
  const schemaItems = (schema as { items?: unknown } | null)?.items;
  const items: unknown[] = Array.isArray(schemaItems) ? schemaItems : [];
  await ctx.db.insert("scrapeResults", {
    monitorId: id,
    matches: (matches ?? items).slice(0, 50),
    totalItems: items.length,
    hasNewMatches: matchCount > 0,
    scrapedAt: now,
  });

  await claimActivation(ctx, monitor, matchCount, "got their first scan", true);

  // Send notifications for initial scan matches. A listing in a product
  // alerts only on stock and price, as in the scheduler.
  if (matchCount > 0 && monitor.groupId === undefined) {
    const stockNote = stockNotShownNote(
      (matches ?? []) as ExtractedItem[],
      (schema as { matchConditions?: MatchConditions } | null)?.matchConditions
    );
    await ctx.scheduler.runAfter(0, internal.monitors.sendInitialScanNotifications, {
      monitorId: id,
      matchCount,
      totalItems: items.length,
      ...(stockNote ? { stockNote } : {}),
    });
  }
}

export const saveScanResult = mutation({
  args: {
    id: v.id("monitors"),
    schema: v.any(),
    matchCount: v.number(),
    contentFingerprint: v.optional(v.string()),
    // Optional only so a browser still running the previous bundle can save.
    matches: v.optional(v.array(v.any())),
  },
  handler: async (ctx, args) => saveScanResultForUser(ctx, await getAuthUserId(ctx), args),
});

/**
 * Activation: the first page we ever managed to read for this user, whether
 * the first scan got it or a later retry did.
 *
 * The marker is claimed in the caller's transaction and the alert scheduled
 * from inside it, so the two cannot disagree — and being stored on the user
 * rather than inferred from their monitors means deleting the monitor cannot
 * produce a second "activated", which reading checkCount across their rows
 * would have done.
 */
export async function claimActivation(
  ctx: MutationCtx,
  monitor: Pick<Doc<"monitors">, "userId" | "userEmail" | "name" | "url" | "createdAt">,
  matchCount: number,
  how: string,
  /** False from the scheduler, where nobody is in the app to have been seen. */
  userPresent: boolean
): Promise<void> {
  const now = Date.now();
  const activity = await ctx.db
    .query("userActivity")
    .withIndex("by_userId", (q) => q.eq("userId", monitor.userId))
    .unique();
  if (activity?.activatedAt) return;
  if (activity) await ctx.db.patch(activity._id, { activatedAt: now });
  // The inactivity reaper trusts lastSeenAt, so a background read must not
  // invent a visit. Creating the monitor is the last time we know they were here.
  else await ctx.db.insert("userActivity", { userId: monitor.userId, lastSeenAt: userPresent ? now : monitor.createdAt, activatedAt: now });
  await ctx.scheduler.runAfter(0, internal.admin.notify, {
    text: `🎉 Activated: ${monitor.userEmail ?? monitor.userId} ${how} — "${monitor.name}" on ${displayHost(monitor.url)}, ${matchCount} match${matchCount === 1 ? "" : "es"}`,
  });
}

/** Mark a scan as failed. */
export async function saveScanErrorForUser(
  ctx: MutationCtx,
  userId: string,
  { id, error }: { id: Id<"monitors">; error: string }
): Promise<void> {
  const monitor = await ctx.db.get(id);
  if (!monitor || monitor.userId !== userId) throw new Error("Monitor not found");

  if (monitor.status !== "scanning" && monitor.status !== "active") return;

  const isBlocked = isBlockedError(error);
  const now = Date.now();

  if (isBlocked && monitor.status === "scanning") {
    // Blocked on initial scan — schedule retries with proxy instead of instant death.
    // Start at retryCount 1 so the scheduler uses proxy on the first retry
    // (retryCount 0 = no proxy = would fail the same way)
    await ctx.db.patch(id, {
      status: "active",
      lastError: error,
      retryCount: 1,
      // A manual retry always gets a fresh proxy-block budget, whether this
      // scan is the monitor's first ever or a rescan of a parked one.
      proxyBlockCount: 0,
      nextCheckAt: now + 30_000, // first retry in 30s
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(id, {
      status: "error",
      lastError: error,
      // Enter the scheduler's slow recovery lane the same way a failed
      // scheduled check does. A lower count would replay the fast backoff
      // ladder (and the paid-tier AI attempt) on a URL already known dead.
      retryCount: MAX_RETRIES,
      proxyBlockCount: 0,
      nextCheckAt: now + ERROR_RECOVERY_INTERVAL_MS,
      updatedAt: now,
    });
  }
}

export const saveScanError = mutation({
  args: {
    id: v.id("monitors"),
    error: v.string(),
  },
  handler: async (ctx, args) => saveScanErrorForUser(ctx, await getAuthUserId(ctx), args),
});

/**
 * One proxy attempt for a first scan, so the person watching gets a result
 * instead of "we'll keep trying". Seven of the first eleven signups in October
 * were blocked here and later read fine through the proxy, by which time they
 * had gone.
 *
 * Two moments ask: before the direct scan, with `knownHost`, when another
 * live monitor on the same site already needs the proxy (so the direct
 * attempt is a known waste of the user's wait); and after a direct scan came
 * back blocked. Either way it is one claim per monitor ever.
 *
 * Returns the URL to fetch, or null. The URL comes from the monitor rather
 * than the caller, and the stamp makes it once per monitor, so the most a
 * session can spend is one call per monitor the creation limit lets it make.
 * Not an escalation: those are capped hourly as a sign of fleet-wide failure,
 * and a burst of signups on protected sites is not one.
 */
export const claimFirstScanProxy = mutation({
  args: { id: v.id("monitors"), knownHost: v.optional(v.boolean()) },
  handler: async (ctx, { id, knownHost }) => {
    const userId = await getAuthUserId(ctx);
    if (await isBanned(ctx, userId)) throw new Error("This account has been suspended.");
    await requireLiveAccount(ctx, userId);
    const monitor = await ctx.db.get(id);
    if (!monitor || monitor.userId !== userId) throw new Error("Monitor not found");
    if (monitor.status !== "scanning" || monitor.checkCount || monitor.firstScanProxyAt) return null;
    if (knownHost && !(await hostNeedsProxy(ctx, monitor))) return null;
    if (await scraperDown(ctx)) return null;
    if (!(await reserveFallback(ctx, false))) return null;
    await ctx.db.patch(id, { firstScanProxyAt: Date.now() });
    return monitor.url;
  },
});

/**
 * Whether another monitor on this site needs the proxy and is still being
 * checked. Read from the fleet rather than kept as a list: the scheduler
 * re-probes a direct fetch every PROXY_REPROBE_EVERY checks and clears
 * proxyPreferred when it works, so a site that drops its protection leaves by
 * itself. A parked monitor is never re-probed, so its flag proves nothing.
 */
async function hostNeedsProxy(ctx: MutationCtx, monitor: Doc<"monitors">): Promise<boolean> {
  const flagged = await ctx.db
    .query("monitors")
    .withIndex("by_host_proxyPreferred", (q) =>
      q.eq("host", monitor.host ?? displayHost(monitor.url)).eq("proxyPreferred", true)
    )
    .take(10);
  return flagged.some(
    (m) => m._id !== monitor._id && m.nextCheckAt !== undefined && (m.status === "active" || m.status === "error")
  );
}

const updateFields = {
  name: v.optional(v.string()),
  url: v.optional(v.string()),
  prompt: v.optional(v.string()),
  status: v.optional(statusValidator),
  checkInterval: v.optional(checkIntervalValidator),
  schema: v.optional(v.any()),
  notificationChannels: v.optional(notificationChannelsValidator),
  muted: v.optional(v.boolean()),
  alertOn: v.optional(alertOnValidator),
};

export const update = mutation({
  args: { id: v.id("monitors"), ...updateFields },
  handler: async (ctx, { id, ...fields }) => updateMonitorForUser(ctx, await getAuthUserId(ctx), id, fields),
});

/**
 * Edit one of this user's monitors. A product rewrites its monitors through
 * this too, passing the plan it read once for all of them.
 */
export async function updateMonitorForUser(
  ctx: MutationCtx,
  userId: string,
  id: Id<"monitors">,
  fields: ObjectType<typeof updateFields>,
  plan?: Plan
): Promise<Id<"monitors">> {
  const existing = await ctx.db.get(id);
  if (!existing || existing.userId !== userId) throw new ConvexError("Monitor not found");
  const needsPlan = fields.checkInterval !== undefined || fields.notificationChannels !== undefined;
  const rules = plan ?? (needsPlan ? await readPlan(ctx, userId) : null);
  if (!rules && (await isBanned(ctx, userId))) throw new ConvexError("This account has been suspended.");

  if (fields.name !== undefined) validateName(fields.name);
  if (fields.url !== undefined) validateMonitorUrl(fields.url);
  if (fields.prompt !== undefined) validatePrompt(fields.prompt);

  if (fields.checkInterval !== undefined && rules) {
    fields.checkInterval = clampInterval(fields.checkInterval, rules.tier);
  }
  if (fields.notificationChannels !== undefined && rules) {
    fields.notificationChannels = allowedChannels(rules, fields.notificationChannels);
  }

  const now = Date.now();
  const updates: Record<string, unknown> = { updatedAt: now };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      updates[key] = typeof value === "string" ? value.trim() : value;
    }
  }
  if (fields.url !== undefined) {
    updates.host = displayHost(fields.url.trim());
    // What the old site needed says nothing about the new one, and left set
    // it would mark the new site as needing the proxy for everyone.
    if (updates.host !== existing.host) updates.proxyPreferred = undefined;
  }

  // Stock was not read while the option was off, and a new URL is a new
  // product. Either way the stored reading is stale, and an old "out of
  // stock" left in place would fire on the first read. Clearing it makes
  // that read a baseline instead. A new price choice resets the price the
  // same way. Each resets only its own half, so editing one option keeps
  // the other's history. Clearing the fingerprint makes the next check read.
  const next = fields.alertOn;
  const before = existing.alertOn;
  const stockTurnedOn = next?.backInStock === true && before?.backInStock !== true;
  const priceChoiceSet =
    (next?.priceDrop === true || next?.priceBelow !== undefined) &&
    (next.priceDrop !== before?.priceDrop ||
      next.priceBelow?.amount !== before?.priceBelow?.amount ||
      next.priceBelow?.currency !== before?.priceBelow?.currency);
  if (next) validateAlertOn(next);
  const urlChanged = fields.url !== undefined && fields.url.trim() !== existing.url;
  if (urlChanged) {
    updates.lastSeen = undefined;
    updates.productFingerprint = undefined;
    // A new page is no longer the product's listing, so it leaves the
    // product rather than the listing taking on a page it doesn't describe.
    updates.productTitle = undefined;
    updates.groupId = undefined;
    await releaseListing(ctx, existing);
  } else if (stockTurnedOn || priceChoiceSet) {
    const { inStock, ...priceState } = existing.lastSeen ?? {};
    updates.lastSeen = {
      ...(!stockTurnedOn && inStock !== undefined ? { inStock } : {}),
      ...(!priceChoiceSet && priceState.price !== undefined && priceState.currency !== undefined ? priceState : {}),
    };
    updates.productFingerprint = undefined;
  }
  // The schema, and the product title in it, describe the old page. Zero
  // makes the drift refresh due, so the next check re-reads the new page
  // and product reads wait until it has (see runQuickCheck).
  if (urlChanged) updates.lastAiExtractAt = 0;

  // Anything that takes a monitor out of "paused" clears the auto-pause and
  // its email link, so the monitor reads as a plain active monitor again and
  // an old email cannot restart it later. Keyed off leaving "paused" rather
  // than off arriving at "active", because Rescan goes paused -> "scanning"
  // -> active and would otherwise leave a running monitor wearing the
  // "paused automatically" note for good.
  //
  // nextCheckAt is set on every resume, not just an auto-paused one: without
  // it a monitor that was parked (nextCheckAt unset) and then paused comes
  // back active with nothing scheduled and never runs again.
  if (fields.status !== undefined && fields.status !== "paused" && existing.status === "paused") {
    updates.nextCheckAt = now;
    updates.autoPausedAt = undefined;
    updates.resumeToken = undefined;
    // Proof of life for the inactivity job. A dashboard resume also moves the
    // session, but an agent's resume over an API key moves nothing else.
    updates.lastResumedAt = now;
    if (existing.nextCheckAt === undefined) {
      // It was parked before it was paused. Same reasoning as the interval
      // branch below: without a fresh budget the next single failure re-parks
      // it and sends another "checks stopped" email.
      updates.proxyBlockCount = 0;
      updates.retryCount = 0;
    }
  }

  // Turning on "in stock only" must queue what the last read saw sold out:
  // those entries are already seen, so nothing else would judge them again.
  if (fields.schema !== undefined) {
    updates.soldOutKeys = soldOutKeysOf(fields.schema, existing.soldOutKeys);
  }

  // A new URL or prompt is in effect a new monitor, whose first error the
  // owner has not been told about.
  if (fields.url !== undefined || fields.prompt !== undefined) {
    updates.lastErrorAlertAt = undefined;
  }

  // Recompute nextCheckAt when interval changes so it takes effect immediately
  if (fields.checkInterval !== undefined) {
    updates.nextCheckAt = now + effectiveIntervalMs({
      checkInterval: fields.checkInterval,
      proxyPreferred: existing.proxyPreferred,
    });
    // This un-parks a parked monitor. Give it a fresh budget on both
    // counters, or the next single failure re-parks it and sends a second
    // "checks stopped" email — a never-succeeded park sits at retryCount 32
    // and would re-park on its very first check.
    updates.proxyBlockCount = 0;
    updates.retryCount = 0;
  }

  await ctx.db.patch(id, updates);
  return id;
}

/**
 * Restart a monitor the inactivity reaper paused, from the link in its pause
 * email. Public and unauthenticated: the 256-bit token in the URL is the whole
 * credential, and the only thing it can do is start this one monitor again.
 *
 * A mutation behind a page rather than an HTTP GET on purpose — mail scanners
 * and link prefetchers fetch every URL in an email, and a GET that resumed
 * would restart monitors nobody clicked, forever.
 */
export const resumeByToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const monitor = await ctx.db
      .query("monitors")
      .withIndex("by_resumeToken", (q) => q.eq("resumeToken", token))
      .unique();
    // Same answer for a tampered link and one already used: there is nothing
    // useful to say about the difference, and no reason to confirm a guess.
    if (!monitor || monitor.autoPausedAt === undefined) return { status: "invalid" as const };
    if (Date.now() - monitor.autoPausedAt > RESUME_TOKEN_TTL_MS) return { status: "expired" as const };
    // banUser only pauses monitors that were live at the time, so one the
    // reaper had already paused keeps its token and would otherwise start
    // checking again on behalf of a suspended account.
    if (await isBanned(ctx, monitor.userId)) return { status: "invalid" as const };

    const now = Date.now();
    await ctx.db.patch(monitor._id, {
      status: "active",
      nextCheckAt: now,
      autoPausedAt: undefined,
      resumeToken: undefined,
      // The proof of life. A dashboard resume moves the session instead, which
      // is what the reaper normally reads; this path has no session to move.
      lastResumedAt: now,
      updatedAt: now,
    });
    return {
      status: "ok" as const,
      monitorId: monitor._id,
      name: monitor.name,
      url: monitor.url,
    };
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

/**
 * Put a monitor's listing back to a suggestion in its product, the same as
 * stopping it there, so the listing never points at a monitor that has gone
 * or now watches another page.
 */
async function releaseListing(ctx: MutationCtx, monitor: Doc<"monitors">): Promise<void> {
  const group = monitor.groupId ? await ctx.db.get(monitor.groupId) : null;
  if (!group) return;
  await ctx.db.patch(group._id, {
    listings: group.listings.map((l) =>
      l.monitorId === monitor._id ? { ...l, state: "suggested" as const, monitorId: undefined } : l
    ),
    updatedAt: Date.now(),
  });
}

export const remove = mutation({
  args: { id: v.id("monitors") },
  handler: async (ctx, { id }) => removeMonitorsForUser(ctx, await getAuthUserId(ctx), [id]),
});

/**
 * Delete some of this user's monitors, then their history and notifications.
 * The history goes in rounds, as account deletion does, because a busy
 * monitor's history can be more than one transaction may delete.
 */
export async function removeMonitorsForUser(ctx: MutationCtx, userId: string, ids: Id<"monitors">[]): Promise<void> {
  let listed = 0;
  for (const id of ids) {
    const existing = await ctx.db.get(id);
    if (!existing || existing.userId !== userId) throw new ConvexError("Monitor not found");
    await ctx.db.delete(id);
    await releaseListing(ctx, existing);
    if (!existing.isAnonymous) listed++;
  }

  // Decrement public monitor counter
  if (listed > 0) {
    const counter = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "monitors")).unique();
    if (counter) await ctx.db.patch(counter._id, { value: Math.max(0, counter.value - listed) });
  }

  await sweepMonitorHistory(ctx, ids);
}

async function sweepMonitorHistory(ctx: MutationCtx, ids: Id<"monitors">[]): Promise<void> {
  const left: Allowance = { bytes: SWEEP_BUDGET_BYTES, rows: SWEEP_BUDGET_ROWS };
  for (const [i, id] of ids.entries()) {
    for (const table of ["scrapeResults", "notifications"] as const) {
      await drain(ctx, ctx.db.query(table).withIndex("by_monitorId", (q) => q.eq("monitorId", id)), left);
      if (spent(left)) {
        await ctx.scheduler.runAfter(0, internal.monitors.sweepRemainingMonitorHistory, { ids: ids.slice(i) });
        return;
      }
    }
  }
}

/** Continues deleting the history of monitors that held more than one round's worth. */
export const sweepRemainingMonitorHistory = internalMutation({
  args: { ids: v.array(v.id("monitors")) },
  handler: async (ctx, { ids }) => {
    await sweepMonitorHistory(ctx, ids);
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

/**
 * Judged scores from the most recent check, keyed by entry.
 *
 * The items tab renders `monitor.schema.items`, which is the AI's model of the
 * page and is only rewritten on a full extract. Scores come from the routine
 * checks in between, so they live on the result row and are joined back here
 * rather than written into the schema, which would mix two different views of
 * the page.
 */
/** Checks looked back through for verdicts. Enough to outlast a quiet spell without paging history. */
const SCORE_LOOKBACK_RESULTS = 20;

export const latestScores = query({
  args: { monitorId: v.id("monitors") },
  handler: async (ctx, { monitorId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return {};
    const monitor = await ctx.db.get(monitorId);
    if (!monitor || monitor.userId !== identity.subject) return {};

    // Not simply the newest row: a check that found nothing new judges nothing
    // and stores no verdicts, so reading only the latest would blank every
    // score on the tab one check after a match arrived.
    const recent = await ctx.db
      .query("scrapeResults")
      .withIndex("by_monitorId_scrapedAt", (q) => q.eq("monitorId", monitorId))
      .order("desc")
      .take(SCORE_LOOKBACK_RESULTS);

    const scored: Record<string, { matchScore: number; matchReason: string }> = {};
    // Oldest first, so a newer verdict on the same entry wins.
    for (const result of [...recent].reverse()) {
      for (const item of (result.scoredCandidates ?? []) as Record<string, unknown>[]) {
        if (typeof item.matchScore !== "number") continue;
        scored[itemIdentity(item)] = {
          matchScore: item.matchScore,
          matchReason: typeof item.matchReason === "string" ? item.matchReason : "",
        };
      }
    }
    return scored;
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
    stockNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const monitor = await ctx.runQuery(internal.monitors.getInternal, { id: args.monitorId });
    if (!monitor) return;
    if (monitor.muted) return; // Muted — skip all notifications

    const plural = args.matchCount !== 1 ? "es" : "";
    const note = args.stockNote ? ` ${args.stockNote}` : "";
    const base = {
      monitorName: monitor.name,
      monitorId: args.monitorId,
      url: monitor.url,
      matchCount: args.matchCount,
      totalItems: args.totalItems,
      ...(args.stockNote ? { stockNote: args.stockNote } : {}),
    };

    // No SMS: the first scan has never texted, and the user is on the page
    // watching it finish.
    await deliverAlert(ctx, monitor, {
      type: "match",
      title: `${monitor.name} — ${args.matchCount} match${plural} found`,
      inAppMessage: `Initial scan found ${args.matchCount} match${plural} out of ${args.totalItems} items on ${monitor.url}.${note}`,
      pushBody: `Initial scan found ${args.matchCount} match${plural} out of ${args.totalItems} items.${note}`,
      email: (to) => ctx.runAction(internal.emails.sendMatchAlert, { ...base, to, matches: [] }),
      telegram: (chatId) => ctx.runAction(internal.telegram.sendMatchAlert, { ...base, chatId }),
      discord: (webhookUrl) => ctx.runAction(internal.discord.sendMatchAlert, { ...base, webhookUrl }),
    });
  },
});
