import { v } from "convex/values";
import { CHANGELOG, latestChangelogEntry, type ChangelogEntry } from "@prowl/shared";
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { isLiveAccount } from "./account";
import { smsEnabled } from "./sms";

/**
 * The newest changelog entry when the signed-in user should get it as a popup,
 * else null. Only the newest counts: an older one nobody dismissed stays on
 * /changelog rather than queueing up.
 */
export const show = query({
  args: {},
  handler: async (ctx): Promise<ChangelogEntry | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const entry = latestChangelogEntry();
    const activity = await ctx.db
      .query("userActivity")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();
    if (activity?.announcementsSeen?.includes(entry.id)) return null;

    // "Set up texts" leads nowhere while the card is switched off, and means nothing to someone already set up.
    if (entry.id === "sms-alerts") {
      if (!smsEnabled()) return null;
      const sms = await ctx.db
        .query("notificationSettings")
        .withIndex("by_userId_channel", (q) => q.eq("userId", identity.subject).eq("channel", "sms"))
        .first();
      if (sms?.enabled) return null;
    }

    // Someone who signed up after it shipped found it already there.
    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", operator: "eq", value: identity.subject }],
    });
    return user !== null && user.createdAt < Date.parse(`${entry.date}T00:00:00Z`) ? entry : null;
  },
});

// Takes the id the dialog showed, so an entry deployed while it was open still pops up.
export const dismiss = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;
    if (!CHANGELOG.some((e) => e.id === id)) return;

    const row = await ctx.db
      .query("userActivity")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();
    if (row) {
      const seen = row.announcementsSeen ?? [];
      if (!seen.includes(id)) {
        await ctx.db.patch(row._id, { announcementsSeen: [...seen, id] });
      }
      return;
    }
    // The dashboard's own touchLastSeen normally got here first; this covers a dismiss that beats it.
    if (!(await isLiveAccount(ctx, identity.subject))) return;
    await ctx.db.insert("userActivity", {
      userId: identity.subject,
      lastSeenAt: Date.now(),
      announcementsSeen: [id],
    });
  },
});
