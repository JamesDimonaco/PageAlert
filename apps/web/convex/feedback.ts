import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const verdictValidator = v.union(v.literal("good"), v.literal("bad"));

/**
 * Record a verdict and act on it.
 *
 * A thumbs-down that only files a row teaches us something and does nothing
 * for the person who pressed it, so "bad" also blacklists the entry — the
 * same list the dismiss button writes to. "good" clears any blacklisting,
 * which is what undo means here.
 */
async function record(
  ctx: MutationCtx,
  args: {
    monitor: Doc<"monitors">;
    itemKey: string;
    itemTitle: string;
    verdict: "good" | "bad";
    matchScore?: number;
    source: "dashboard" | "telegram";
  }
) {
  const { monitor, itemKey, verdict } = args;

  const existing = await ctx.db
    .query("matchFeedback")
    .withIndex("by_monitor_item", (q) =>
      q.eq("monitorId", monitor._id).eq("itemKey", itemKey)
    )
    .unique();

  const row = {
    userId: monitor.userId,
    monitorId: monitor._id,
    itemKey,
    itemTitle: args.itemTitle,
    verdict,
    matchScore: args.matchScore,
    prompt: monitor.prompt,
    source: args.source,
    createdAt: Date.now(),
  };

  if (existing) {
    await ctx.db.patch(existing._id, row);
  } else {
    await ctx.db.insert("matchFeedback", row);
  }

  const blacklist = monitor.blacklistedItems ?? [];
  const shouldBlacklist = verdict === "bad";
  const isBlacklisted = blacklist.includes(itemKey);
  if (shouldBlacklist && !isBlacklisted) {
    await ctx.db.patch(monitor._id, {
      blacklistedItems: [...blacklist, itemKey],
      updatedAt: Date.now(),
    });
  } else if (!shouldBlacklist && isBlacklisted) {
    await ctx.db.patch(monitor._id, {
      blacklistedItems: blacklist.filter((k) => k !== itemKey),
      updatedAt: Date.now(),
    });
  }
}

export const submit = mutation({
  args: {
    monitorId: v.id("monitors"),
    itemKey: v.string(),
    itemTitle: v.string(),
    verdict: verdictValidator,
    matchScore: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor || monitor.userId !== identity.subject) {
      throw new Error("Monitor not found");
    }

    await record(ctx, { ...args, monitor, source: "dashboard" });
  },
});

/**
 * Drop a verdict.
 *
 * Restoring an entry that a thumbs-down hid has to retract the verdict too,
 * or the thumbs data keeps an answer the user visibly took back — and that
 * data is what the score threshold gets calibrated against.
 */
export const clear = mutation({
  args: { monitorId: v.id("monitors"), itemKey: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor || monitor.userId !== identity.subject) return;

    const existing = await ctx.db
      .query("matchFeedback")
      .withIndex("by_monitor_item", (q) =>
        q.eq("monitorId", args.monitorId).eq("itemKey", args.itemKey)
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const forMonitor = query({
  args: { monitorId: v.id("monitors") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return {};

    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor || monitor.userId !== identity.subject) return {};

    const rows = await ctx.db
      .query("matchFeedback")
      .withIndex("by_monitorId", (q) => q.eq("monitorId", args.monitorId))
      .collect();

    return Object.fromEntries(rows.map((r) => [r.itemKey, r.verdict]));
  },
});

/**
 * Record a verdict pressed on a Telegram alert.
 *
 * The button only carries a result row and an index, so the entry is read
 * back from the alert that was actually sent. The chat is resolved to a user
 * independently and has to be the monitor's owner: a callback payload is
 * attacker-controlled, and the ids in it are guessable.
 */
export const submitFromTelegram = internalMutation({
  args: {
    chatId: v.string(),
    resultId: v.string(),
    index: v.number(),
    verdict: verdictValidator,
  },
  handler: async (ctx, args): Promise<{ ok: boolean; title?: string }> => {
    const setting = await ctx.db
      .query("notificationSettings")
      .withIndex("by_channel_target", (q) =>
        q.eq("channel", "telegram").eq("target", args.chatId)
      )
      .unique();
    if (!setting) return { ok: false };

    // normalizeId, not a cast: a callback payload is attacker-controlled, and
    // db.get throws on a malformed id before the promise exists, so the throw
    // escapes any .catch and the button spins forever on the user's phone.
    const resultId = ctx.db.normalizeId("scrapeResults", args.resultId);
    if (!resultId) return { ok: false };
    const result = await ctx.db.get(resultId);
    if (!result) return { ok: false };

    const monitor = await ctx.db.get(result.monitorId);
    if (!monitor || monitor.userId !== setting.userId) return { ok: false };

    const item = (result.matches as Record<string, unknown>[])[args.index];
    if (!item) return { ok: false };

    // Same shape as getItemKey in @prowl/shared, which is what the blacklist
    // is keyed on — a different key here would file the verdict and still
    // let the entry alert again.
    const itemKey = item.url
      ? String(item.url)
      : `${String(item.title ?? "")}-${String(item.price ?? "")}`;
    if (!itemKey.trim() || itemKey === "-") return { ok: false };

    await record(ctx, {
      monitor,
      itemKey,
      itemTitle: String(item.title ?? itemKey),
      verdict: args.verdict,
      matchScore: typeof item.matchScore === "number" ? item.matchScore : undefined,
      source: "telegram",
    });

    return { ok: true, title: String(item.title ?? itemKey) };
  },
});
