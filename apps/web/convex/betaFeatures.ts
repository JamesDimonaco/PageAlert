import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireLiveAccount } from "./account";
import { betaFeature, type BetaFeature } from "./schema";

export function activityRow(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query("userActivity")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

/** Has this user switched the feature on? Off unless they have. */
export async function hasBetaFeature(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  feature: BetaFeature
): Promise<boolean> {
  const row = await activityRow(ctx, userId);
  return row?.betaFeatures?.includes(feature) ?? false;
}

/** The beta features the signed-in user has on. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<BetaFeature[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const row = await activityRow(ctx, identity.subject);
    return row?.betaFeatures ?? [];
  },
});

export const set = mutation({
  args: { feature: betaFeature, enabled: v.boolean() },
  handler: async (ctx, { feature, enabled }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = identity.subject;
    await requireLiveAccount(ctx, userId);

    const row = await activityRow(ctx, userId);
    const others = (row?.betaFeatures ?? []).filter((f) => f !== feature);
    const betaFeatures = enabled ? [...others, feature] : others;
    if (row) {
      await ctx.db.patch(row._id, { betaFeatures });
      return;
    }
    await ctx.db.insert("userActivity", { userId, lastSeenAt: Date.now(), betaFeatures });
  },
});
