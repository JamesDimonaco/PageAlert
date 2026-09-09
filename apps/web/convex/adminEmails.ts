import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAdmin } from "./admin";
import { MAX_SEND_LATENESS_MS } from "./onboarding";

/**
 * Super-admin email operations: the onboarding queue and the delivery record.
 * Split out of admin.ts, which is already long and mixes dashboard reads with
 * one-off recovery tooling.
 *
 * Every public function here calls requireAdmin from ./admin.
 */

const stepValidator = v.union(v.literal("day0"), v.literal("day1"), v.literal("day3"), v.literal("day7"));
type Step = "day0" | "day1" | "day3" | "day7";
const STEPS: Step[] = ["day0", "day1", "day3", "day7"];

/**
 * Per (step, status) read cap for the queue overview.
 *
 * Counting rows means reading them, and this query reads four statuses across
 * four steps — so the cap is really a sixteenth of a budget. Convex refuses a
 * query past 16,384 documents, and `sent`, `skipped` and the never-processed
 * day1/3/7 `pending` rows all grow with every signup, so a generous cap here
 * would eventually take the whole tab down rather than degrade. 500 keeps the
 * worst case at 8,000 and is far more depth than an operator needs to act on;
 * `truncated` says when a column is showing a floor rather than a total.
 */
const QUEUE_SAMPLE_CAP = 500;

export const emailQueue = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const staleThreshold = Date.now() - MAX_SEND_LATENESS_MS;

    const steps = await Promise.all(
      STEPS.map(async (step) => {
        const byStatus = (status: "pending" | "sent" | "failed" | "skipped") =>
          ctx.db
            .query("onboardingEmails")
            .withIndex("by_step_status_scheduledFor", (q) => q.eq("step", step).eq("status", status))
            .take(QUEUE_SAMPLE_CAP);

        const [pending, sent, failed, skipped] = await Promise.all([
          byStatus("pending"),
          byStatus("sent"),
          byStatus("failed"),
          byStatus("skipped"),
        ]);

        const stalePending = pending.filter((r) => r.scheduledFor < staleThreshold).length;
        const truncated = [pending, sent, failed, skipped].some((rows) => rows.length === QUEUE_SAMPLE_CAP);

        return {
          step,
          pending: pending.length,
          sent: sent.length,
          failed: failed.length,
          skipped: skipped.length,
          stalePending,
          truncated,
        };
      }),
    );

    return steps;
  },
});

// Cap on rows changed per call. The UI reports "more remain" so an admin can
// click again rather than one call trying to walk an unbounded backlog.
const BATCH_CAP = 500;

export const retireStaleQueued = mutation({
  args: { step: stepValidator },
  handler: async (ctx, { step }) => {
    await requireAdmin(ctx);
    const staleThreshold = Date.now() - MAX_SEND_LATENESS_MS;
    const found = await ctx.db
      .query("onboardingEmails")
      .withIndex("by_step_status_scheduledFor", (q) =>
        q.eq("step", step).eq("status", "pending").lt("scheduledFor", staleThreshold),
      )
      .take(BATCH_CAP + 1);
    const toRetire = found.slice(0, BATCH_CAP);
    for (const row of toRetire) {
      await ctx.db.patch(row._id, { status: "skipped", error: "Retired by admin" });
    }
    return { retired: toRetire.length, moreRemain: found.length > BATCH_CAP };
  },
});

/**
 * Only the onboarding queue can be requeued this way: it regenerates its
 * email from a template at send time. emailSends (the record behind
 * recentSends below) stores only delivery metadata, not the rendered
 * content, so there is no equivalent "requeue" for a match/error/price
 * alert that already failed.
 */
export const requeueFailed = mutation({
  // day0 only: it is the sole step processDueEmails sends, so requeueing any
  // other step would move a row that nothing will ever pick up.
  args: { step: v.literal("day0") },
  handler: async (ctx, { step }) => {
    await requireAdmin(ctx);
    const found = await ctx.db
      .query("onboardingEmails")
      .withIndex("by_step_status_scheduledFor", (q) => q.eq("step", step).eq("status", "failed"))
      .take(BATCH_CAP + 1);
    const toRequeue = found.slice(0, BATCH_CAP);
    const now = Date.now();
    for (const row of toRequeue) {
      // scheduledFor is rewritten so the row clears the staleness window and
      // actually sends. Safe for day0, whose original time is signup time and
      // carries no meaning once the send has already failed.
      await ctx.db.patch(row._id, { status: "pending", scheduledFor: now, error: undefined });
    }
    return { requeued: toRequeue.length, moreRemain: found.length > BATCH_CAP };
  },
});

const emailSendStatusValidator = v.union(
  v.literal("sent"),
  v.literal("failed"),
  v.literal("delivered"),
  v.literal("bounced"),
  v.literal("complained"),
);

const RECENT_SENDS_DEFAULT = 50;
const RECENT_SENDS_MAX = 200;

export const recentSends = query({
  args: { status: v.optional(emailSendStatusValidator), limit: v.optional(v.number()) },
  handler: async (ctx, { status, limit }) => {
    await requireAdmin(ctx);
    const take = Math.min(RECENT_SENDS_MAX, Math.max(1, Math.floor(limit ?? RECENT_SENDS_DEFAULT)));
    const rows = status
      ? await ctx.db
          .query("emailSends")
          .withIndex("by_status_createdAt", (q) => q.eq("status", status))
          .order("desc")
          .take(take)
      : await ctx.db.query("emailSends").withIndex("by_createdAt").order("desc").take(take);
    return rows.map((r) => ({
      _id: r._id,
      to: r.to,
      kind: r.kind,
      status: r.status,
      error: r.error,
      createdAt: r.createdAt,
      resendId: r.resendId,
    }));
  },
});
