import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireLiveAccount } from "./account";
import { claimSlot } from "./admin";
import { FEEDBACK_MAX, feedbackSlotKey } from "./shared";
import { effectiveTier } from "./tiers";

const MIN_INTERVAL_MS = 60 * 1000;

const KINDS = {
  bug: "🐛 Bug",
  idea: "💡 Idea",
  other: "💬 Message",
} as const;

/**
 * "Send feedback" from the user menu. Goes to James on Telegram; he replies by email.
 * ConvexError, not Error: Convex hides a plain Error's message in production.
 */
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
    if (!text) throw new ConvexError("Write a message first.");
    if (text.length > FEEDBACK_MAX) throw new ConvexError(`Keep it under ${FEEDBACK_MAX} characters.`);

    if (!(await claimSlot(ctx, feedbackSlotKey(identity.subject), MIN_INTERVAL_MS))) {
      throw new ConvexError("You just sent one. Try again in a minute.");
    }

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
