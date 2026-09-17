/**
 * Pause monitors whose owners have gone.
 *
 * A daily cron pauses a live monitor when its owner has not opened the app for
 * 30 days and has ignored at least one alert from it, or 90 days regardless,
 * and emails them one restart link that needs no login. Paying owners are
 * exempt. The rules themselves live in `dormancyVerdict` (@prowl/shared), the
 * only part with tests.
 *
 * KILL SWITCH: INACTIVITY_PAUSE_ENABLED. Anything but "true" makes the run a
 * dry run — it works out the same list and logs it, but pauses nothing and
 * sends nothing. That log is how the first prod run gets checked against the
 * plan before anybody's monitor stops.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { dormancyVerdict, type DormancyVerdict } from "@prowl/shared";
import { fetchAllUsers, fetchLastActiveByUser, isPayingRecord } from "./admin";
import { effectiveIntervalMs } from "./shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ceiling on the live monitors one run considers. Well above the fleet (65 at
 * the time of writing); a run that hits it pauses what it saw and says so,
 * rather than quietly doing half the job.
 */
const MAX_LIVE_MONITORS = 1000;

/** Alerts counted for the email's "we sent N alerts in that time" line. */
const MAX_ALERTS_COUNTED = 50;

const ruleValidator = v.union(v.literal("ignored-alert"), v.literal("long-gone"));

type Candidate = {
  id: Id<"monitors">;
  userId: string;
  name: string;
  url: string;
  rule: Exclude<DormancyVerdict, "keep">;
  checksPerDay: number;
};

/**
 * 32 random bytes as hex. Hex rather than base64url because it needs no
 * encoder that may or may not exist in this runtime, and it is URL-safe by
 * construction — the length of the link is not worth a dependency.
 */
function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Every monitor still being checked, owned by a signed-up user.
 *
 * Anonymous monitors are excluded here rather than left to the verdict: they
 * expire on their own via anonymous.cleanupExpired, and they have no owner to
 * email.
 */
export const listLive = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = [];
    let truncated = false;
    for (const status of ["active", "error"] as const) {
      const page = await ctx.db
        .query("monitors")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(MAX_LIVE_MONITORS);
      if (page.length === MAX_LIVE_MONITORS) truncated = true;
      rows.push(...page);
    }
    const live = rows.filter((m) => !m.isAnonymous && m.nextCheckAt !== undefined);
    return {
      monitors: live.map((m) => ({
        id: m._id,
        userId: m.userId,
        name: m.name,
        url: m.url,
        status: m.status,
        lastMatchAt: m.lastMatchAt,
        nextCheckAt: m.nextCheckAt,
        createdAt: m.createdAt,
        lastResumedAt: m.lastResumedAt,
        checksPerDay: DAY_MS / effectiveIntervalMs(m),
      })),
      truncated,
    };
  },
});

/**
 * Per owner: whether they are paying, and when they last created a monitor.
 *
 * Creation is a real "was here" moment, and `monitorCreations` keeps it even
 * for monitors since deleted or paused — so a user who set something up last
 * week is safe even if the monitor we are judging is an old one. Monitor
 * `updatedAt` is no use as a signal: the scheduler bumps it on every check.
 */
export const ownerFacts = internalQuery({
  args: { userIds: v.array(v.string()) },
  handler: async (ctx, { userIds }) => {
    const facts: Array<{ userId: string; isPaying: boolean; lastCreatedMonitorAt: number | null }> = [];
    for (const userId of userIds) {
      const tier = await ctx.db
        .query("userTiers")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();
      const newest = await ctx.db
        .query("monitorCreations")
        .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
        .order("desc")
        .first();
      facts.push({
        userId,
        isPaying: tier ? isPayingRecord(tier) : false,
        lastCreatedMonitorAt: newest?.createdAt ?? null,
      });
    }
    return facts;
  },
});

/**
 * Pause one owner's dormant monitors and queue their notice.
 *
 * One owner is one transaction, so a crash halfway through the run leaves
 * nobody half-done: either their monitors are paused and their email is
 * queued, or neither happened.
 */
export const pauseForOwner = internalMutation({
  args: {
    userId: v.string(),
    lastSeenAt: v.number(),
    monitors: v.array(v.object({
      id: v.id("monitors"),
      token: v.string(),
      rule: ruleValidator,
    })),
  },
  handler: async (ctx, { userId, lastSeenAt, monitors }) => {
    const now = Date.now();
    const paused: Array<{
      id: string;
      name: string;
      url: string;
      token: string;
      rule: "ignored-alert" | "long-gone";
      alertCount: number;
    }> = [];
    let email: string | undefined;

    for (const { id, token, rule } of monitors) {
      // Re-read: the list was built in an action, so the user may have resumed,
      // paused or deleted it since.
      const m = await ctx.db.get(id);
      if (!m || m.userId !== userId) continue;
      if (m.status !== "active" && m.status !== "error") continue;
      if (m.nextCheckAt === undefined) continue;
      if (m.autoPausedAt !== undefined) continue;

      await ctx.db.patch(id, {
        status: "paused",
        autoPausedAt: now,
        resumeToken: token,
        updatedAt: now,
      });

      const alerts = await ctx.db
        .query("notifications")
        .withIndex("by_monitorId", (q) => q.eq("monitorId", id))
        .order("desc")
        .take(MAX_ALERTS_COUNTED);
      const alertCount = alerts.filter((n) => n.channel === "in_app" && n.sentAt > lastSeenAt).length;

      await ctx.db.insert("notifications", {
        userId,
        monitorId: id,
        channel: "in_app",
        title: `Paused: ${m.name}`,
        message: "We stopped checking this because you hadn't been back for a while. Resume it any time — nothing was deleted.",
        sentAt: now,
        read: false,
      });

      email = email ?? m.userEmail;
      paused.push({ id, name: m.name, url: m.url, token, rule, alertCount });
    }

    if (paused.length > 0) {
      // Scheduled from inside the transaction, so the notice cannot be sent
      // for a pause that rolled back, nor lost for one that committed.
      await ctx.scheduler.runAfter(0, internal.inactivity.notifyPaused, {
        userId,
        email,
        lastSeenAt,
        monitors: paused,
      });
    }
    return paused.length;
  },
});

/**
 * Tell the owner, on every channel they have.
 *
 * Deliberately not gated on the monitor's `muted` flag or its notification
 * channel list, the way a match alert is. Mute means "stop telling me what you
 * found"; this is "we have stopped looking", and the whole design rests on the
 * pause being announced.
 */
export const notifyPaused = internalAction({
  args: {
    userId: v.string(),
    email: v.optional(v.string()),
    lastSeenAt: v.number(),
    monitors: v.array(v.object({
      id: v.string(),
      name: v.string(),
      url: v.string(),
      token: v.string(),
      rule: ruleValidator,
      alertCount: v.number(),
    })),
  },
  handler: async (ctx, { userId, email, lastSeenAt, monitors }) => {
    if (email) {
      await ctx.runAction(internal.emails.sendInactivityPaused, {
        to: email,
        userId,
        lastSeenAt,
        monitors,
      }).catch((e) => console.error("[inactivity] pause email failed:", userId, e));
    }

    const telegram = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
      userId,
      channel: "telegram",
    });
    if (telegram?.enabled && telegram.target) {
      for (const m of monitors) {
        await ctx.runAction(internal.telegram.sendInactivityPaused, {
          chatId: telegram.target,
          monitorName: m.name,
          url: m.url,
          lastSeenAt,
          token: m.token,
        }).catch(() => {});
      }
    }

    const discord = await ctx.runQuery(internal.scheduler.getNotificationSetting, {
      userId,
      channel: "discord",
    });
    if (discord?.enabled && discord.target) {
      for (const m of monitors) {
        await ctx.runAction(internal.discord.sendInactivityPaused, {
          webhookUrl: discord.target,
          monitorName: m.name,
          url: m.url,
          lastSeenAt,
          token: m.token,
        }).catch(() => {});
      }
    }
  },
});

/** Daily cron. See the file header for the kill switch. */
export const pauseDormant = internalAction({
  args: {},
  handler: async (ctx) => {
    const enabled = process.env.INACTIVITY_PAUSE_ENABLED === "true";
    const now = Date.now();

    const [live, users, sessions] = await Promise.all([
      ctx.runQuery(internal.inactivity.listLive, {}),
      fetchAllUsers(ctx),
      fetchLastActiveByUser(ctx),
    ]);

    // A scan that ran out of pages rather than rows makes the users it never
    // reached look like they have never been seen, which would pause every one
    // of their monitors in one morning. Nothing is worth doing on a partial map.
    if (!users.complete || !sessions.complete) {
      const text = `[inactivity] ABORTED: ${users.complete ? "session" : "user"} scan truncated. No monitors paused.`;
      console.error(text);
      await ctx.runAction(internal.admin.notify, { text });
      return { aborted: true as const };
    }

    const signupByUser = new Map(users.users.map((u) => [u.id, u.createdAt]));
    const owners = [...new Set(live.monitors.map((m) => m.userId))];
    const facts = await ctx.runQuery(internal.inactivity.ownerFacts, { userIds: owners });
    const factByUser = new Map(facts.map((f) => [f.userId, f]));

    // Newest live monitor per owner, as one more "was here" moment on top of
    // what monitorCreations remembers — and the last restart from a pause
    // email, which is the one that stops this cron talking to itself. Clicking
    // that link does not sign anyone in, so without it a restarted monitor is
    // still owned by someone "last seen" months ago and tomorrow's run pauses
    // it again, and again, one email a day forever.
    const newestLiveByUser = new Map<string, number>();
    for (const m of live.monitors) {
      newestLiveByUser.set(m.userId, Math.max(
        newestLiveByUser.get(m.userId) ?? 0,
        m.createdAt,
        m.lastResumedAt ?? 0,
      ));
    }

    const lastSeenByUser = new Map<string, number>();
    for (const userId of owners) {
      lastSeenByUser.set(userId, Math.max(
        sessions.byUser.get(userId) ?? 0,
        signupByUser.get(userId) ?? 0,
        factByUser.get(userId)?.lastCreatedMonitorAt ?? 0,
        newestLiveByUser.get(userId) ?? 0,
      ));
    }

    const candidates: Candidate[] = [];
    for (const m of live.monitors) {
      const lastSeenAt = lastSeenByUser.get(m.userId) ?? 0;
      // A user we know nothing about — no session, no signup row, no creation
      // log — reads as epoch-old, which is exactly the shape a truncated scan
      // would fake. The guard above rules that out, but leaving them running
      // costs a few checks and stopping them wrongly costs a user.
      if (lastSeenAt === 0) continue;
      const verdict = dormancyVerdict({
        now,
        lastSeenAt,
        lastMatchAt: m.lastMatchAt,
        nextCheckAt: m.nextCheckAt,
        status: m.status,
        isPaying: factByUser.get(m.userId)?.isPaying ?? false,
      });
      if (verdict === "keep") continue;
      candidates.push({ id: m.id, userId: m.userId, name: m.name, url: m.url, rule: verdict, checksPerDay: m.checksPerDay });
    }

    const byOwner = new Map<string, Candidate[]>();
    for (const c of candidates) {
      byOwner.set(c.userId, [...(byOwner.get(c.userId) ?? []), c]);
    }

    const ruleA = candidates.filter((c) => c.rule === "ignored-alert").length;
    const checksSaved = Math.round(candidates.reduce((sum, c) => sum + c.checksPerDay, 0));

    if (!enabled) {
      for (const c of candidates) {
        console.log(`[inactivity] would pause: ${c.name} (${c.userId}, ${c.rule}, ${c.checksPerDay.toFixed(1)} checks/day)`);
      }
    }

    let paused = 0;
    if (enabled) {
      for (const [userId, list] of byOwner) {
        paused += await ctx.runMutation(internal.inactivity.pauseForOwner, {
          userId,
          lastSeenAt: lastSeenByUser.get(userId)!,
          monitors: list.map((c) => ({ id: c.id, token: mintToken(), rule: c.rule })),
        });
      }
    }

    // One operator message for the run, not one per user.
    const summary =
      `[inactivity] ${enabled ? `paused ${paused}` : `would pause ${candidates.length}`} monitor(s) ` +
      `for ${byOwner.size} user(s) (rule A ${ruleA}, rule B ${candidates.length - ruleA}), ` +
      `saving ~${checksSaved} checks/day of ${Math.round(live.monitors.reduce((s, m) => s + m.checksPerDay, 0))}.` +
      `${enabled ? "" : " DRY RUN — switch is off."}${live.truncated ? " WARNING: live-monitor list was truncated." : ""}`;
    console.log(summary);
    await ctx.runAction(internal.admin.notify, { text: summary });

    return { candidates: candidates.length, owners: byOwner.size, paused, dryRun: !enabled };
  },
});
