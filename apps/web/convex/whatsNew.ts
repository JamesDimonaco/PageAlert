import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { isLiveAccount } from "./account";
import { smsEnabled } from "./sms";
import { SMS_LIMITS } from "./tiers";

/**
 * Accounts created at or after this moment signed up with texts already on
 * offer, and get onboarding instead of the dialog. Move it to the ship date if
 * the launch slips.
 */
export const SMS_ANNOUNCED_AT = Date.UTC(2026, 9, 5);

const SMS_ANNOUNCEMENT_ID = "sms-alerts";

/**
 * The free-tier text limits when the signed-in user should see the "texts are
 * here" dialog, else null. The dialog quotes them, so they come from SMS_LIMITS
 * rather than being typed into the copy.
 */
export const show = query({
  args: {},
  handler: async (ctx): Promise<{ month: number; day: number } | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    // The settings card is hidden while the flag is off, so the button would lead nowhere.
    if (!smsEnabled()) return null;

    const activity = await ctx.db
      .query("userActivity")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();
    if (activity?.announcementsSeen?.includes(SMS_ANNOUNCEMENT_ID)) return null;

    const sms = await ctx.db
      .query("notificationSettings")
      .withIndex("by_userId_channel", (q) => q.eq("userId", identity.subject).eq("channel", "sms"))
      .first();
    if (sms?.enabled) return null;

    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", operator: "eq", value: identity.subject }],
    });
    return user !== null && user.createdAt < SMS_ANNOUNCED_AT ? SMS_LIMITS.free : null;
  },
});

export const dismiss = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;

    const row = await ctx.db
      .query("userActivity")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();
    if (row) {
      const seen = row.announcementsSeen ?? [];
      if (!seen.includes(SMS_ANNOUNCEMENT_ID)) {
        await ctx.db.patch(row._id, { announcementsSeen: [...seen, SMS_ANNOUNCEMENT_ID] });
      }
      return;
    }
    // The dashboard's own touchLastSeen normally got here first; this covers a dismiss that beats it.
    if (!(await isLiveAccount(ctx, identity.subject))) return;
    await ctx.db.insert("userActivity", {
      userId: identity.subject,
      lastSeenAt: Date.now(),
      announcementsSeen: [SMS_ANNOUNCEMENT_ID],
    });
  },
});
