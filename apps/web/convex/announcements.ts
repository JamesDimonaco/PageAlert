import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { isLiveAccount } from "./account";
import { smsEnabled } from "./sms";

/**
 * Accounts created at or after this moment signed up with texts already on
 * offer, and get onboarding instead of the dialog. Move it to the ship date if
 * the launch slips.
 */
export const SMS_ANNOUNCED_AT = Date.UTC(2026, 9, 5);

const SMS_ANNOUNCEMENT_ID = "sms-alerts";

/** Whether to show the "texts are here" dialog to the signed-in user. */
export const whatsNew = query({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    // The settings card is hidden while the flag is off, so the button would lead nowhere.
    if (!smsEnabled()) return false;

    const activity = await ctx.db
      .query("userActivity")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();
    if (activity?.announcementsSeen?.includes(SMS_ANNOUNCEMENT_ID)) return false;

    const sms = await ctx.db
      .query("notificationSettings")
      .withIndex("by_userId_channel", (q) => q.eq("userId", identity.subject).eq("channel", "sms"))
      .first();
    if (sms?.enabled) return false;

    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", operator: "eq", value: identity.subject }],
    });
    return user !== null && user.createdAt < SMS_ANNOUNCED_AT;
  },
});

export const dismissWhatsNew = mutation({
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
