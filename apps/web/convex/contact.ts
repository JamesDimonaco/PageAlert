import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireLiveAccount } from "./account";
import { FEEDBACK_MAX } from "./shared";
import { effectiveTier } from "./tiers";

const MIN_INTERVAL_MS = 60 * 1000;

const KINDS = {
  bug: "🐛 Bug",
  idea: "💡 Idea",
  other: "💬 Message",
} as const;

/** "Send feedback" from the user menu. Goes to James on Telegram; he replies by email. */
export const send = mutation({
  args: {
    kind: v.union(v.literal("bug"), v.literal("idea"), v.literal("other")),
    message: v.string(),
    page: v.string(),
  },
  handler: async (ctx, { kind, message, page }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    await requireLiveAccount(ctx, identity.subject);

    const text = message.trim();
    if (!text) throw new Error("Write a message first.");
    if (text.length > FEEDBACK_MAX) throw new Error(`Keep it under ${FEEDBACK_MAX} characters.`);

    const allowed = await ctx.runMutation(internal.admin.claimAlertSlot, {
      key: `contact:${identity.subject}`,
      minIntervalMs: MIN_INTERVAL_MS,
    });
    if (!allowed) throw new Error("You just sent one. Try again in a minute.");

    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();

    await ctx.scheduler.runAfter(0, internal.admin.notify, {
      text: [
        `${KINDS[kind]} from ${identity.email ?? identity.subject} (${effectiveTier(record)})`,
        `Page: ${page.slice(0, 200)}`,
        "",
        text,
      ].join("\n"),
    });
  },
});
