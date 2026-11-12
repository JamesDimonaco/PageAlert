import { ConvexError, v, type Infer } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isBanned } from "./account";

/**
 * Turning one alert channel on (or back off) across a user's monitors.
 *
 * Connecting a channel turns it on everywhere at once (see
 * notificationSettings.upsert and pushSubscriptions.subscribe), and the
 * settings page and each monitor offer to turn it on wherever it is still
 * off. Texts are not here: they cost money per message, so /sms-policy
 * promises they are only ever on where the user switched them on.
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

/**
 * A list left unset means every channel already (see alertChannels), so it
 * needs nothing added.
 */
function lacks(list: Doc<"monitors">["notificationChannels"], channel: RolloutChannel): boolean {
  return list !== undefined && !list.includes(channel);
}

/**
 * Add a channel to the user's monitors, or to one monitor or product. A
 * monitor in a product brings the whole product with it.
 */
export async function turnOnChannel(
  ctx: MutationCtx,
  userId: string,
  channel: RolloutChannel,
  scope: { monitorId?: Id<"monitors">; groupId?: Id<"monitorGroups"> } = {}
): Promise<Rollout> {
  let groupId = scope.groupId;
  let monitors: Doc<"monitors">[];
  if (scope.monitorId !== undefined) {
    const monitor = await ctx.db.get(scope.monitorId);
    if (!monitor || monitor.userId !== userId) throw new ConvexError("Monitor not found");
    groupId = monitor.groupId;
    monitors = [monitor];
  } else {
    monitors = [];
  }

  let groups: Doc<"monitorGroups">[];
  if (groupId !== undefined) {
    const group = await ctx.db.get(groupId);
    if (!group || group.userId !== userId) throw new ConvexError("Product not found.");
    groups = [group];
    monitors = await ctx.db
      .query("monitors")
      .withIndex("by_groupId", (q) => q.eq("groupId", group._id))
      .collect();
  } else if (scope.monitorId === undefined) {
    // Bounded by the plan's monitor limit.
    monitors = await ctx.db.query("monitors").withIndex("by_userId", (q) => q.eq("userId", userId)).collect();
    groups = await ctx.db.query("monitorGroups").withIndex("by_userId", (q) => q.eq("userId", userId)).collect();
  } else {
    groups = [];
  }

  const now = Date.now();
  const rollout: Rollout = { monitorIds: [], groupIds: [] };
  for (const m of monitors) {
    if (m.userId !== userId || !lacks(m.notificationChannels, channel)) continue;
    await ctx.db.patch(m._id, { notificationChannels: [...m.notificationChannels!, channel], updatedAt: now });
    rollout.monitorIds.push(m._id);
  }
  for (const g of groups) {
    if (!lacks(g.notificationChannels, channel)) continue;
    await ctx.db.patch(g._id, { notificationChannels: [...g.notificationChannels!, channel], updatedAt: now });
    rollout.groupIds.push(g._id);
  }
  return rollout;
}

async function requireUser(ctx: MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Not authenticated");
  if (await isBanned(ctx, identity.subject)) throw new ConvexError("This account has been suspended.");
  return identity.subject;
}

/** Turn a channel on for every monitor, or for one monitor or product. */
export const turnOn = mutation({
  args: {
    channel: rolloutChannelValidator,
    monitorId: v.optional(v.id("monitors")),
    groupId: v.optional(v.id("monitorGroups")),
  },
  handler: async (ctx, { channel, monitorId, groupId }): Promise<Rollout> => {
    const userId = await requireUser(ctx);
    return turnOnChannel(ctx, userId, channel, { monitorId, groupId });
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

/**
 * Every monitor and product the user has, and which channels each is
 * missing. The settings page and the monitor page pick out the channels the
 * user has connected; this doesn't know which those are.
 */
export const coverage = query({
  args: {},
  handler: async (ctx): Promise<CoverageUnit[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = identity.subject;
    // Both bounded by the plan's monitor limit.
    const monitors = await ctx.db.query("monitors").withIndex("by_userId", (q) => q.eq("userId", userId)).collect();
    const groups = await ctx.db.query("monitorGroups").withIndex("by_userId", (q) => q.eq("userId", userId)).collect();

    const missingFrom = (lists: Array<Doc<"monitors">["notificationChannels"]>) =>
      ROLLOUT_CHANNELS.filter((c) => lists.some((list) => lacks(list, c)));

    const units: CoverageUnit[] = groups.map((g) => ({
      kind: "product",
      id: g._id,
      name: g.name,
      missing: missingFrom([
        g.notificationChannels,
        ...monitors.filter((m) => m.groupId === g._id).map((m) => m.notificationChannels),
      ]),
    }));
    const grouped = new Set(groups.map((g) => g._id as string));
    for (const m of monitors) {
      if (m.groupId !== undefined && grouped.has(m.groupId)) continue;
      units.push({ kind: "monitor", id: m._id, name: m.name, missing: missingFrom([m.notificationChannels]) });
    }
    return units;
  },
});
