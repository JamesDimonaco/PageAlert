import { ConvexError, v, type Infer } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isBanned } from "./account";

/**
 * Turning alert channels on (or back off) across a user's monitors.
 *
 * Connecting a channel turns it on everywhere at once, the first time (see
 * rolloutOnConnect). After that, the settings page and each monitor offer to
 * turn it on wherever it is still off. Texts are not here: they cost money per
 * message, so /sms-policy promises they are only ever on where the user
 * switched them on.
 *
 * A product's monitors share one channel list, so a product is changed as a
 * whole: its own row and every listing in it.
 */
const ROLLOUT_CHANNELS = ["email", "push", "telegram", "discord"] as const;

export const rolloutChannelValidator = v.union(
  v.literal("email"),
  v.literal("push"),
  v.literal("telegram"),
  v.literal("discord")
);
export type RolloutChannel = Infer<typeof rolloutChannelValidator>;

/** What a rollout changed, so the client can offer to undo exactly that. */
export type Rollout = { monitorIds: Id<"monitors">[]; groupIds: Id<"monitorGroups">[] };

const NOTHING: Rollout = { monitorIds: [], groupIds: [] };

/**
 * Far past any plan's monitor limit. A user who downgraded can keep more
 * monitors than their plan allows, so the limit itself isn't a bound.
 */
const MAX_ROWS = 2000;

type Ctx = QueryCtx | MutationCtx;

function userMonitors(ctx: Ctx, userId: string) {
  return ctx.db.query("monitors").withIndex("by_userId", (q) => q.eq("userId", userId)).take(MAX_ROWS);
}

function userGroups(ctx: Ctx, userId: string) {
  return ctx.db.query("monitorGroups").withIndex("by_userId", (q) => q.eq("userId", userId)).take(MAX_ROWS);
}

/** Bounded by the product's listings, one monitor each at most. */
function groupMonitors(ctx: Ctx, groupId: Id<"monitorGroups">) {
  return ctx.db.query("monitors").withIndex("by_groupId", (q) => q.eq("groupId", groupId)).take(MAX_ROWS);
}

/** A list left unset means every channel already (see alertChannels), so it needs nothing added. */
function lacks(list: Doc<"monitors">["notificationChannels"], channel: RolloutChannel): boolean {
  return list !== undefined && !list.includes(channel);
}

type Scope = { monitorId?: Id<"monitors">; groupId?: Id<"monitorGroups"> };

/** The monitors and products a scope covers. A monitor in a product brings the whole product. */
async function inScope(
  ctx: Ctx,
  userId: string,
  scope: Scope
): Promise<{ monitors: Doc<"monitors">[]; groups: Doc<"monitorGroups">[] }> {
  let groupId = scope.groupId;
  if (scope.monitorId !== undefined) {
    const monitor = await ctx.db.get(scope.monitorId);
    if (!monitor || monitor.userId !== userId) throw new ConvexError("Monitor not found");
    if (monitor.groupId === undefined) return { monitors: [monitor], groups: [] };
    groupId = monitor.groupId;
  }
  if (groupId !== undefined) {
    const group = await ctx.db.get(groupId);
    if (!group || group.userId !== userId) throw new ConvexError("Product not found.");
    return { monitors: await groupMonitors(ctx, group._id), groups: [group] };
  }
  return { monitors: await userMonitors(ctx, userId), groups: await userGroups(ctx, userId) };
}

/** Add channels to the user's monitors, or to one monitor or product. */
async function turnOnChannels(
  ctx: MutationCtx,
  userId: string,
  channels: RolloutChannel[],
  scope: Scope = {}
): Promise<Rollout> {
  const { monitors, groups } = await inScope(ctx, userId, scope);
  const now = Date.now();
  const rollout: Rollout = { monitorIds: [], groupIds: [] };
  for (const m of monitors) {
    const add = channels.filter((c) => lacks(m.notificationChannels, c));
    if (m.userId !== userId || add.length === 0) continue;
    await ctx.db.patch(m._id, { notificationChannels: [...m.notificationChannels!, ...add], updatedAt: now });
    rollout.monitorIds.push(m._id);
  }
  for (const g of groups) {
    const add = channels.filter((c) => lacks(g.notificationChannels, c));
    if (add.length === 0) continue;
    await ctx.db.patch(g._id, { notificationChannels: [...g.notificationChannels!, ...add], updatedAt: now });
    rollout.groupIds.push(g._id);
  }
  return rollout;
}

/**
 * A channel the user just connected goes on every monitor, so they don't
 * have to tick it on each. Only the first time per channel: someone who
 * reconnects Telegram, or re-enables a push device that went stale, has made
 * per-monitor choices since, and the settings banner covers any monitor
 * still without it. A suspended account's monitors are left alone, as every
 * other edit path does.
 */
export async function rolloutOnConnect(ctx: MutationCtx, userId: string, channel: RolloutChannel): Promise<Rollout> {
  if (await isBanned(ctx, userId)) return NOTHING;
  const done = await ctx.db
    .query("channelRollouts")
    .withIndex("by_userId_and_channel", (q) => q.eq("userId", userId).eq("channel", channel))
    .first();
  if (done) return NOTHING;
  await ctx.db.insert("channelRollouts", { userId, channel, at: Date.now() });
  return turnOnChannels(ctx, userId, [channel]);
}

async function requireUser(ctx: MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Not authenticated");
  if (await isBanned(ctx, identity.subject)) throw new ConvexError("This account has been suspended.");
  return identity.subject;
}

/** Turn channels on for every monitor, or for one monitor or product. */
export const turnOn = mutation({
  args: {
    channels: v.array(rolloutChannelValidator),
    monitorId: v.optional(v.id("monitors")),
    groupId: v.optional(v.id("monitorGroups")),
  },
  handler: async (ctx, { channels, monitorId, groupId }): Promise<Rollout> => {
    const userId = await requireUser(ctx);
    return turnOnChannels(ctx, userId, channels, { monitorId, groupId });
  },
});

/**
 * Undo a rollout: take the channel back off exactly the monitors and products
 * it was added to. Each keeps at least one channel, so none is left alerting
 * nobody.
 */
export const undo = mutation({
  args: {
    channel: rolloutChannelValidator,
    monitorIds: v.array(v.id("monitors")),
    groupIds: v.array(v.id("monitorGroups")),
  },
  handler: async (ctx, { channel, monitorIds, groupIds }) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    for (const id of monitorIds) {
      const m = await ctx.db.get(id);
      if (!m || m.userId !== userId || !m.notificationChannels?.includes(channel)) continue;
      const rest = m.notificationChannels.filter((c) => c !== channel);
      if (rest.length > 0) await ctx.db.patch(m._id, { notificationChannels: rest, updatedAt: now });
    }
    for (const id of groupIds) {
      const g = await ctx.db.get(id);
      if (!g || g.userId !== userId || !g.notificationChannels?.includes(channel)) continue;
      const rest = g.notificationChannels.filter((c) => c !== channel);
      if (rest.length > 0) await ctx.db.patch(g._id, { notificationChannels: rest, updatedAt: now });
    }
    return null;
  },
});

/** A monitor, or a product counted once for all its listings, and the channels it is missing. */
export type CoverageUnit = {
  kind: "monitor" | "product";
  id: Id<"monitors"> | Id<"monitorGroups">;
  name: string;
  missing: RolloutChannel[];
};

function missingFrom(lists: Array<Doc<"monitors">["notificationChannels"]>): RolloutChannel[] {
  return ROLLOUT_CHANNELS.filter((c) => lists.some((list) => lacks(list, c)));
}

function productUnit(group: Doc<"monitorGroups">, monitors: Doc<"monitors">[]): CoverageUnit {
  return {
    kind: "product",
    id: group._id,
    name: group.name,
    missing: missingFrom([group.notificationChannels, ...monitors.map((m) => m.notificationChannels)]),
  };
}

/**
 * Every monitor and product the user has, and which channels each is
 * missing, for the settings page. It doesn't know which channels the user
 * has connected; the page picks those out.
 */
export const coverage = query({
  args: {},
  handler: async (ctx): Promise<CoverageUnit[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const monitors = await userMonitors(ctx, identity.subject);
    const groups = await userGroups(ctx, identity.subject);

    const units = groups.map((g) => productUnit(g, monitors.filter((m) => m.groupId === g._id)));
    const grouped = new Set<string>(groups.map((g) => g._id));
    for (const m of monitors) {
      if (m.groupId !== undefined && grouped.has(m.groupId)) continue;
      units.push({ kind: "monitor", id: m._id, name: m.name, missing: missingFrom([m.notificationChannels]) });
    }
    return units;
  },
});

/**
 * The same for one monitor or product, for its page. Reads only that unit, so
 * other monitors' checks don't re-run it. A monitor in a product answers for
 * the product.
 */
export const coverageOf = query({
  args: { monitorId: v.optional(v.id("monitors")), groupId: v.optional(v.id("monitorGroups")) },
  handler: async (ctx, scope): Promise<CoverageUnit | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || (scope.monitorId === undefined && scope.groupId === undefined)) return null;
    try {
      const { monitors, groups } = await inScope(ctx, identity.subject, scope);
      const group = groups[0];
      if (group) return productUnit(group, monitors);
      const monitor = monitors[0];
      if (!monitor) return null;
      return { kind: "monitor", id: monitor._id, name: monitor.name, missing: missingFrom([monitor.notificationChannels]) };
    } catch {
      // Deleted, or not theirs: nothing to nudge about.
      return null;
    }
  },
});
