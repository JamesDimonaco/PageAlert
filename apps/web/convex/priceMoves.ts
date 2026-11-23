import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export type PriceDrop = {
  monitorId: Id<"monitors">;
  from: number;
  to: number;
  currency: string;
  changedAt: number;
};

/**
 * The signed-in user's monitors whose latest price change was a fall, alert
 * or not. priceReads holds one row per accepted change, and a held misread
 * never lands there, so the newest two rows are the last move.
 */
export const listMine = query({
  args: {},
  handler: async (ctx): Promise<PriceDrop[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const monitors = await ctx.db
      .query("monitors")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .collect();
    const drops = await Promise.all(
      monitors
        .filter((m) => m.lastSeen?.price !== undefined)
        .map(async (m): Promise<PriceDrop | null> => {
          const [latest, previous] = await ctx.db
            .query("priceReads")
            .withIndex("by_monitorId", (q) => q.eq("monitorId", m._id))
            .order("desc")
            .take(2);
          if (!latest || !previous || latest.currency !== previous.currency || latest.price >= previous.price) return null;
          return { monitorId: m._id, from: previous.price, to: latest.price, currency: latest.currency, changedAt: latest.readAt };
        })
    );
    return drops.filter((d) => d !== null);
  },
});
