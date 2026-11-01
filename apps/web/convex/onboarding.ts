import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Onboarding email scheduler.
 *
 * Each new user gets four `onboardingEmails` rows queued at signup:
 * day0 (welcome, sent immediately), day1 (gentle nudge), day3 (3 starter
 * ideas), day7 (3 more ideas). An hourly cron processes due rows.
 *
 * day1 goes only to someone with no monitor yet. Anyone unsubscribed from
 * tips gets none of them.
 *
 * The whole sender is gated behind ONBOARDING_EMAILS_ENABLED=true.
 * See PROWL-038.
 */

/**
 * Schedule a target time at 10:00 UTC `daysFromNow` days from now.
 * 10:00 UTC is a globally inoffensive hour: early evening in Asia,
 * mid-morning in Europe, early morning in the Americas. Not perfect,
 * but we don't track user timezones yet.
 */
function nextDayAt10UTC(daysFromNow: number): number {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  d.setUTCHours(10, 0, 0, 0);
  return d.getTime();
}

/**
 * Idempotent — called from the user-create database hook in
 * convex/betterAuth/auth.ts. If anything is already queued for this
 * user we no-op (protects against retries, fixture imports, etc.).
 */
export const queueWelcomeSequence = internalMutation({
  args: { userId: v.string(), email: v.string() },
  handler: async (ctx, { userId, email }) => {
    const existing = await ctx.db
      .query("onboardingEmails")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    if (existing) return;

    const now = Date.now();
    const rows: Array<{
      step: "day0" | "day1" | "day3" | "day7";
      scheduledFor: number;
    }> = [
      { step: "day0", scheduledFor: now },
      { step: "day1", scheduledFor: nextDayAt10UTC(1) },
      { step: "day3", scheduledFor: nextDayAt10UTC(3) },
      { step: "day7", scheduledFor: nextDayAt10UTC(7) },
    ];

    for (const row of rows) {
      await ctx.db.insert("onboardingEmails", {
        userId,
        email,
        step: row.step,
        scheduledFor: row.scheduledFor,
        status: "pending",
      });
    }

    // Kick the processor right away so the day0 email goes out without
    // waiting for the next hourly tick. The processor is internally
    // gated by ONBOARDING_EMAILS_ENABLED so this is safe even before
    // the kill switch is flipped.
    await ctx.scheduler.runAfter(0, internal.onboarding.processDueEmails, {});

    // Tell the operator. This function is the once-per-user new-signup hook —
    // it returns early above if anything is already queued — so the alert
    // inherits that guard and a retried signup cannot send a second one.
    await ctx.scheduler.runAfter(0, internal.admin.notify, {
      text: `New signup: ${email}`,
    });
  },
});

const STEPS = ["day0", "day1", "day3", "day7"] as const;

/**
 * A queued email this far past its scheduled time is stale. Send it and the
 * user gets "welcome to PageAlert" months after signing up, so mark it skipped
 * instead. Also stops a long processor outage from blasting a backlog the
 * moment it recovers.
 */
export const MAX_SEND_LATENESS_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Claims the rows that are due and still fresh enough to send, by moving them
 * to "sending". A signup kicks the processor while the hourly cron may also be
 * running; claiming in a mutation means only one of them gets each row.
 *
 * The lower bound matters as much as the upper one: stale rows are excluded by
 * the query rather than skipped inside the loop, so a backlog can never occupy
 * the window and starve a new signup. That is the same shape as the bug this
 * file is fixing, one level down.
 */
export const claimDue = internalMutation({
  args: { step: v.union(v.literal("day0"), v.literal("day1"), v.literal("day3"), v.literal("day7")) },
  handler: async (ctx, { step }) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("onboardingEmails")
      .withIndex("by_step_status_scheduledFor", (q) =>
        q
          .eq("step", step)
          .eq("status", "pending")
          .gte("scheduledFor", now - MAX_SEND_LATENESS_MS)
          .lte("scheduledFor", now)
      )
      .take(50);
    for (const row of rows) await ctx.db.patch(row._id, { status: "sending" });
    return rows;
  },
});

/**
 * Retire rows too old to send. Separate from the send path so the two can
 * never compete for the same budget, and generous enough to clear a real
 * backlog in one pass.
 */
export const sweepStale = internalMutation({
  args: { step: v.union(v.literal("day0"), v.literal("day1"), v.literal("day3"), v.literal("day7")) },
  handler: async (ctx, { step }) => {
    const stale = await ctx.db
      .query("onboardingEmails")
      .withIndex("by_step_status_scheduledFor", (q) =>
        q
          .eq("step", step)
          .eq("status", "pending")
          .lt("scheduledFor", Date.now() - MAX_SEND_LATENESS_MS)
      )
      .take(500);
    for (const row of stale) {
      await ctx.db.patch(row._id, { status: "skipped", error: "Too late to send" });
    }
    return stale.length;
  },
});

export const markSent = internalMutation({
  args: { id: v.id("onboardingEmails") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { status: "sent", sentAt: Date.now() });
  },
});

export const markSkipped = internalMutation({
  args: { id: v.id("onboardingEmails"), error: v.string() },
  handler: async (ctx, { id, error }) => {
    await ctx.db.patch(id, { status: "skipped", error });
  },
});

export const markFailed = internalMutation({
  args: { id: v.id("onboardingEmails"), error: v.string() },
  handler: async (ctx, { id, error }) => {
    await ctx.db.patch(id, { status: "failed", error });
  },
});

/**
 * Hourly processor. Walks the pending queue and dispatches due emails.
 *
 * KILL SWITCH: gated by ONBOARDING_EMAILS_ENABLED. When unset the queue
 * still fills up but nothing actually sends.
 */
export const processDueEmails = internalAction({
  args: {},
  handler: async (ctx) => {
    const enabled = process.env.ONBOARDING_EMAILS_ENABLED === "true";
    if (!enabled) {
      console.log(
        "[onboarding] ONBOARDING_EMAILS_ENABLED is not 'true' — skipping send"
      );
      return;
    }

    // One step at a time, each with its own window, so a backlog in one step
    // can never crowd out another.
    for (const step of STEPS) {
      const swept = await ctx.runMutation(internal.onboarding.sweepStale, { step });
      if (swept > 0) console.log(`[onboarding] retired ${swept} stale ${step} row(s)`);

      const due = await ctx.runMutation(internal.onboarding.claimDue, { step });
      if (due.length === 0) continue;
      const userIds = due.map((r) => r.userId);
      const optedOut = new Set(await ctx.runQuery(internal.unsubscribe.optedOutAmong, { userIds, category: "tips" }));
      const started =
        step === "day1" ? new Set(await ctx.runQuery(internal.onboarding.withMonitors, { userIds })) : new Set<string>();

      for (const row of due) {
        const skip = optedOut.has(row.userId) ? "Unsubscribed from tips" : started.has(row.userId) ? "Already has a monitor" : null;
        if (skip) {
          await ctx.runMutation(internal.onboarding.markSkipped, { id: row._id, error: skip });
          continue;
        }
        try {
          if (step === "day0") {
            await ctx.runAction(internal.emails.sendOnboardingDay0, { to: row.email, userId: row.userId });
          } else {
            await ctx.runAction(internal.emails.sendOnboardingFollowUp, { to: row.email, userId: row.userId, step });
          }
          await ctx.runMutation(internal.onboarding.markSent, { id: row._id });
        } catch (e) {
          await ctx.runMutation(internal.onboarding.markFailed, {
            id: row._id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  },
});

/** Of these users, the ones who have ever created a monitor, deleted ones included. */
export const withMonitors = internalQuery({
  args: { userIds: v.array(v.string()) },
  handler: async (ctx, { userIds }) => {
    const out: string[] = [];
    for (const userId of userIds) {
      const created = await ctx.db
        .query("monitorCreations")
        .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
        .first();
      if (created) out.push(userId);
    }
    return out;
  },
});

/**
 * One-off: skipFollowUpBacklog also retired rows that were not due yet.
 * This puts those back. Delete once it has run on prod.
 *
 *   npx convex run --prod onboarding:restoreNotYetDue
 */
export const restoreNotYetDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let restored = 0;
    for (const step of ["day1", "day3", "day7"] as const) {
      const rows = await ctx.db
        .query("onboardingEmails")
        .withIndex("by_step_status_scheduledFor", (q) =>
          q.eq("step", step).eq("status", "skipped").gt("scheduledFor", now)
        )
        .take(1000);
      for (const row of rows) {
        if (row.error !== "Queued before follow-ups launched") continue;
        await ctx.db.patch(row._id, { status: "pending", error: undefined });
        restored++;
      }
    }
    return { restored };
  },
});

/**
 * Dev-only manual trigger. Bypasses the kill switch so a developer
 * can email themselves to review the template:
 *
 *   npx convex run onboarding:sendWelcomeEmailNow \
 *     '{"to":"you@example.com","userId":"<your-user-id>"}'
 *
 * Does NOT touch the queue — this is a fire-and-forget test send.
 */
export const sendWelcomeEmailNow = internalAction({
  args: { to: v.string(), userId: v.string() },
  handler: async (ctx, { to, userId }) => {
    await ctx.runAction(internal.emails.sendOnboardingDay0, { to, userId });
  },
});

