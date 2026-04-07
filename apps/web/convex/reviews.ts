import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const MAX_QUOTE_LENGTH = 200;
const MAX_NAME_LENGTH = 50;
const MAX_ROLE_LENGTH = 50;
const MAX_PUBLIC_REVIEWS = 12;

/** Submit a review (one per user) */
export const submit = mutation({
  args: {
    displayName: v.string(),
    role: v.optional(v.string()),
    quote: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = identity.subject;

    // Validate
    if (args.displayName.trim().length === 0)
      throw new Error("Name is required");
    if (args.displayName.length > MAX_NAME_LENGTH)
      throw new Error(`Name must be under ${MAX_NAME_LENGTH} characters`);
    if (args.quote.trim().length === 0)
      throw new Error("Review text is required");
    if (args.quote.length > MAX_QUOTE_LENGTH)
      throw new Error(`Review must be under ${MAX_QUOTE_LENGTH} characters`);
    if (args.role && args.role.length > MAX_ROLE_LENGTH)
      throw new Error(`Role must be under ${MAX_ROLE_LENGTH} characters`);

    // One per user
    const existing = await ctx.db
      .query("reviews")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    if (existing) throw new Error("You've already submitted a review");

    // Verify eligibility (2+ non-anonymous monitors)
    const monitors = await ctx.db
      .query("monitors")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    if (monitors.filter((m) => !m.isAnonymous).length < 2) {
      throw new Error("Create at least 2 monitors before submitting a review");
    }

    await ctx.db.insert("reviews", {
      userId,
      displayName: args.displayName.trim(),
      role: args.role?.trim() || undefined,
      quote: args.quote.trim(),
      createdAt: Date.now(),
    });
  },
});

/** Dismiss the review prompt permanently */
export const dismiss = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = identity.subject;

    const record = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (record) {
      await ctx.db.patch(record._id, { reviewDismissed: true } as any);
    } else {
      await ctx.db.insert("userTiers", {
        userId,
        tier: "free",
        reviewDismissed: true,
        updatedAt: Date.now(),
      } as any);
    }
  },
});

/** Check if user should see the review prompt */
export const shouldPrompt = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    const userId = identity.subject;

    // Already submitted?
    const existing = await ctx.db
      .query("reviews")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    if (existing) return false;

    // Permanently dismissed?
    const tier = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if ((tier as any)?.reviewDismissed) return false;

    // Has 2+ non-anonymous monitors?
    const monitors = await ctx.db
      .query("monitors")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    return monitors.filter((m) => !m.isAnonymous).length >= 2;
  },
});

/** List reviews for the homepage (public, no auth) */
export const listPublic = query({
  args: {},
  handler: async (ctx) => {
    const reviews = await ctx.db
      .query("reviews")
      .order("desc")
      .take(MAX_PUBLIC_REVIEWS);
    return reviews.map((r) => ({
      id: r._id,
      displayName: r.displayName,
      role: r.role,
      quote: r.quote,
    }));
  },
});
