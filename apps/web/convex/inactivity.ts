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
import { DAY_MS, DORMANT_AFTER_MS, dormancyVerdict, lastSeenFrom, type DormancyVerdict } from "@prowl/shared";
import { fetchAllUsers, fetchLastActiveByUser, isPayingRecord } from "./admin";
import { effectiveIntervalMs } from "./shared";

/**
 * Ceiling on the live monitors one run considers — a stop, not a promise. Well
 * above the fleet (65 at the time of writing); a run that hits it pauses what
 * it saw and says so, rather than quietly doing half the job. Long before it
 * bites, `ownerFacts` below needs paging: see the scale table in
 * docs/plans/inactive-monitor-auto-pause.md.
 */
const MAX_LIVE_MONITORS = 1000;

/** See the heartbeat claim below. */
const HEARTBEAT_SLACK_MS = 60 * 60 * 1000;

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
        // Muted, or every channel switched off: its matches reached nobody.
        alertsSuppressed: m.muted === true || m.notificationChannels?.length === 0,
        checksPerDay: DAY_MS / effectiveIntervalMs(m),
      })),
      truncated,
    };
  },
});

/**
 * Per owner: whether they are paying, when the dashboard last saw them, and
 * when they last created a monitor.
 *
 * `userActivity` is the signal that survives a sign-out; creation is a real
 * "was here" moment too, and `monitorCreations` keeps it even for monitors
 * since deleted, so a user who set something up last week is safe even if the
 * monitor we are judging is an old one. Monitor `updatedAt` is no use as a
 * signal: the scheduler bumps it on every check.
 */
export const ownerFacts = internalQuery({
  args: { userIds: v.array(v.string()) },
  handler: async (ctx, { userIds }) => {
    const facts: Array<{
      userId: string;
      isPaying: boolean;
      touchedAt: number | null;
      lastCreatedMonitorAt: number | null;
    }> = [];
    for (const userId of userIds) {
      const tier = await ctx.db
        .query("userTiers")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();
      const activity = await ctx.db
        .query("userActivity")
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
        touchedAt: activity?.lastSeenAt ?? null,
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
    })),
  },
  handler: async (ctx, { userId, lastSeenAt, monitors }) => {
    const now = Date.now();

    // The verdicts were worked out in an action, before this transaction
    // opened. Anything that makes the owner ineligible in between — they open
    // the dashboard, they buy a plan — has to win, because pausing a monitor
    // belonging to someone who is right there is the failure this whole feature
    // is trying not to commit.
    const tier = await ctx.db
      .query("userTiers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (tier && isPayingRecord(tier)) return 0;
    const activity = await ctx.db
      .query("userActivity")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (activity && now - activity.lastSeenAt < DORMANT_AFTER_MS) return 0;

    const paused: Array<{
      id: string;
      name: string;
      url: string;
      token: string;
      /** When it last matched, if that was after we last saw the owner. */
      matchedSinceSeenAt?: number;
    }> = [];
    let email: string | undefined;

    for (const { id, token } of monitors) {
      // Re-read: the list was built in an action, so the user may have resumed,
      // paused or deleted it since.
      const m = await ctx.db.get(id);
      if (!m || m.userId !== userId) continue;
      if (m.status !== "active" && m.status !== "error") continue;
      if (m.nextCheckAt === undefined) continue;

      await ctx.db.patch(id, {
        status: "paused",
        autoPausedAt: now,
        resumeToken: token,
        updatedAt: now,
      });

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
      paused.push({
        id,
        name: m.name,
        url: m.url,
        token,
        matchedSinceSeenAt: m.lastMatchAt !== undefined && m.lastMatchAt > lastSeenAt ? m.lastMatchAt : undefined,
      });
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
      matchedSinceSeenAt: v.optional(v.number()),
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
        }).catch((e) => console.error("[inactivity] Telegram pause notice failed:", userId, e));
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
        }).catch((e) => console.error("[inactivity] Discord pause notice failed:", userId, e));
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

    // Per owner: the newest monitor they own, and the last time one of them was
    // restarted from a pause email. The restart is the one that stops this cron
    // talking to itself — clicking that link signs nobody in, so without it a
    // restarted monitor is still owned by someone "last seen" months ago and
    // tomorrow's run pauses it again, one email a day forever.
    const newestLiveByUser = new Map<string, number>();
    const resumedByUser = new Map<string, number>();
    for (const m of live.monitors) {
      newestLiveByUser.set(m.userId, Math.max(newestLiveByUser.get(m.userId) ?? 0, m.createdAt));
      if (m.lastResumedAt !== undefined) {
        resumedByUser.set(m.userId, Math.max(resumedByUser.get(m.userId) ?? 0, m.lastResumedAt));
      }
    }

    const lastSeenByUser = new Map<string, number>();
    for (const userId of owners) {
      const facts = factByUser.get(userId);
      lastSeenByUser.set(userId, lastSeenFrom({
        touchedAt: facts?.touchedAt ?? undefined,
        sessionAt: sessions.byUser.get(userId),
        signupAt: signupByUser.get(userId),
        monitorCreatedAt: Math.max(facts?.lastCreatedMonitorAt ?? 0, newestLiveByUser.get(userId) ?? 0),
        resumedAt: resumedByUser.get(userId),
      }));
    }

    const candidates: Candidate[] = [];
    for (const m of live.monitors) {
      const verdict = dormancyVerdict({
        now,
        lastSeenAt: lastSeenByUser.get(m.userId) ?? 0,
        lastMatchAt: m.lastMatchAt,
        nextCheckAt: m.nextCheckAt,
        status: m.status,
        isPaying: factByUser.get(m.userId)?.isPaying ?? false,
        alertsSuppressed: m.alertsSuppressed,
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
          monitors: list.map((c) => ({ id: c.id, token: mintToken() })),
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
    // A daily "0 monitors" ping is how an operator learns to ignore a channel,
    // but total silence means a dead cron and a live one look identical from
    // the outside. So: speak when something happened, and once a week
    // regardless, which is the heartbeat that says the schedule is still alive.
    // Claimed rather than keyed off the weekday: if the one Monday run is
    // missed — a deploy, an outage, a skipped cron — a weekday test stays
    // quiet for another seven days, which is the silence this exists to break.
    // The slot only advances when it is actually due, so the heartbeat
    // reschedules itself off the last one sent.
    const hasNews = candidates.length > 0 || live.truncated;
    const heartbeatDue = await ctx.runMutation(internal.admin.claimAlertSlot, {
      key: "inactivity:heartbeat",
      // Short of seven days on purpose: the claim is stamped after the user and
      // session scans, so the run's own duration varies and an exact week would
      // miss by seconds and slip a day, every week.
      minIntervalMs: 7 * DAY_MS - HEARTBEAT_SLACK_MS,
    });
    if (hasNews || heartbeatDue) {
      await ctx.runAction(internal.admin.notify, {
        text: hasNews
          ? summary
          : `${summary}\n\nWeekly check-in: the reaper is running and had nothing to pause.`,
      });
    }

    return { candidates: candidates.length, owners: byOwner.size, paused, dryRun: !enabled };
  },
});
