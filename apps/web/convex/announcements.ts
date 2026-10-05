import { v } from "convex/values";
import type { PaginationResult } from "convex/server";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { APP_URL, HELLO_FROM_EMAIL, RESEND_TIMEOUT, esc } from "./emails";
import { SMS_LIMITS } from "./tiers";
import { unsubscribeUrl } from "./unsubscribe";

/**
 * One-off product announcements to every user, run by hand:
 *
 *   npx convex run --prod announcements:send '{"key":"sms-alerts-2026-10"}'
 *   npx convex run --prod announcements:send '{"key":"sms-alerts-2026-10","dryRun":false}'
 *
 * A new announcement is a new entry in ANNOUNCEMENTS under a new key. The key
 * is also what makes a rerun safe: one announcementSends row per user per key.
 */

/** Resend's batch endpoint takes at most 100 emails per call. */
export const ANNOUNCEMENT_BATCH_SIZE = 100;
// One batch call per interval is well inside Resend's default 10 requests a
// second, and matches the pace admin.sendBulkEmail already runs at.
const BATCH_SPACING_MS = 600;
// An action may run 10 minutes; stop well short and hand the rest to a fresh one.
const RUN_BUDGET_MS = 5 * 60_000;

type Announcement = {
  subject: string;
  render: (unsubscribeLink: string) => { html: string; text: string };
};

const smsAlerts: Announcement = {
  subject: "PageAlert can now text you",
  render: (unsubscribeLink) => {
    const settingsHref = `${APP_URL}/dashboard/settings`;
    const freeTexts = SMS_LIMITS.free.month;
    const paragraphs = [
      "PageAlert can now send you a text message the moment a monitor finds a match or a price drops.",
      "A text reaches you faster than an email, which helps when stock sells out in minutes.",
      `Free accounts get ${freeTexts} texts a month. Paid plans get more.`,
    ];
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0a0a0b">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
      <div style="background:#3b82f6;padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600">Text message alerts</h1>
      </div>
      <div style="padding:32px;line-height:1.55">
        ${paragraphs.map((p) => `<p style="margin:0 0 16px;color:#444;font-size:15px">${esc(p)}</p>`).join("\n        ")}
        <a href="${esc(settingsHref)}" style="display:inline-block;background:#3b82f6;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin-top:8px">
          Turn on text alerts
        </a>
        <p style="margin:12px 0 0;color:#888;font-size:12px">Settings, then Notifications, then SMS.</p>
      </div>
      <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #eee">
        <p style="margin:0;color:#999;font-size:12px">
          You are getting this because you have a PageAlert account.
          <a href="${esc(unsubscribeLink)}" style="color:#999">Unsubscribe from product updates</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;
    const text = `${paragraphs.join("\n\n")}

Turn on text alerts (Settings, then Notifications, then SMS):
${settingsHref}

You are getting this because you have a PageAlert account.
Unsubscribe from product updates: ${unsubscribeLink}`;
    return { html, text };
  },
};

const ANNOUNCEMENTS: Record<string, Announcement> = {
  "sms-alerts-2026-10": smsAlerts,
};

const recipientValidator = v.object({ userId: v.string(), email: v.string() });
type Recipient = { userId: string; email: string };

/** Everyone in `users` who has not opted out and has no live row for this key. Failed rows are eligible again. */
async function eligible(ctx: QueryCtx, key: string, users: Recipient[]): Promise<Recipient[]> {
  const out: Recipient[] = [];
  for (const user of users) {
    const optedOut = await ctx.db
      .query("productUpdateOptOuts")
      .withIndex("by_userId", (q) => q.eq("userId", user.userId))
      .first();
    if (optedOut) continue;
    const prior = await ctx.db
      .query("announcementSends")
      .withIndex("by_key_userId", (q) => q.eq("key", key).eq("userId", user.userId))
      .first();
    if (prior && prior.status !== "failed") continue;
    out.push(user);
  }
  return out;
}

export const countEligible = internalQuery({
  args: { key: v.string(), users: v.array(recipientValidator) },
  handler: async (ctx, { key, users }) => (await eligible(ctx, key, users)).length,
});

/**
 * Marks recipients as pending before anything is sent. A crash between this
 * and the send leaves a pending row that a rerun skips: a missed email is
 * recoverable by hand, a duplicate one is not.
 */
export const claim = internalMutation({
  args: { key: v.string(), users: v.array(recipientValidator) },
  handler: async (ctx, { key, users }) => {
    const toSend = await eligible(ctx, key, users);
    const now = Date.now();
    for (const user of toSend) {
      const prior = await ctx.db
        .query("announcementSends")
        .withIndex("by_key_userId", (q) => q.eq("key", key).eq("userId", user.userId))
        .first();
      if (prior) await ctx.db.patch(prior._id, { status: "pending", error: undefined, updatedAt: now });
      else await ctx.db.insert("announcementSends", { key, userId: user.userId, status: "pending", updatedAt: now });
    }
    return toSend;
  },
});

export const settle = internalMutation({
  args: { key: v.string(), userIds: v.array(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, { key, userIds, error }) => {
    const now = Date.now();
    for (const userId of userIds) {
      const row = await ctx.db
        .query("announcementSends")
        .withIndex("by_key_userId", (q) => q.eq("key", key).eq("userId", userId))
        .first();
      if (row) await ctx.db.patch(row._id, { status: error ? "failed" : "sent", error, updatedAt: now });
    }
  },
});

type Totals = { sent: number; failed: number };

async function sendBatch(
  ctx: ActionCtx,
  key: string,
  announcement: Announcement,
  batch: Recipient[],
  apiKey: string,
  replyTo: string
): Promise<Totals> {
  const payload = await Promise.all(
    batch.map(async (r) => {
      const link = await unsubscribeUrl(r.userId);
      const { html, text } = announcement.render(link);
      return {
        from: HELLO_FROM_EMAIL,
        to: [r.email],
        reply_to: replyTo,
        subject: announcement.subject,
        html,
        text,
        headers: { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      };
    })
  );

  let error: string | undefined;
  let ids: { id?: string }[] = [];
  try {
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RESEND_TIMEOUT),
    });
    if (res.ok) {
      ids = ((await res.json().catch(() => ({}))) as { data?: { id?: string }[] }).data ?? [];
    } else {
      error = `Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  await ctx.runMutation(internal.announcements.settle, { key, userIds: batch.map((r) => r.userId), error });
  await ctx.runMutation(internal.emailEvents.recordSends, {
    kind: `announcement:${key}`,
    sends: batch.map((r, i) => ({ to: r.email, resendId: ids[i]?.id })),
    ok: !error,
    error,
  });
  if (error) console.error(`[announcements] ${key} batch failed:`, error);
  return error ? { sent: 0, failed: batch.length } : { sent: batch.length, failed: 0 };
}

export const send = internalAction({
  args: {
    key: v.string(),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const announcement = ANNOUNCEMENTS[args.key];
    if (!announcement) throw new Error(`Unknown announcement "${args.key}"`);

    const apiKey = process.env.RESEND_API_KEY;
    // hello@ is send-only, so replies need somewhere real to land
    const replyTo = process.env.ADMIN_EMAIL;
    if (!dryRun && (!apiKey || !replyTo)) throw new Error("RESEND_API_KEY and ADMIN_EMAIL must be set");

    const started = Date.now();
    let cursor = args.cursor ?? null;
    let wouldSend = 0;
    const totals: Totals = { sent: 0, failed: 0 };

    for (;;) {
      const page: PaginationResult<Record<string, unknown>> = await ctx.runQuery(
        components.betterAuth.adapter.findMany,
        { model: "user", paginationOpts: { numItems: ANNOUNCEMENT_BATCH_SIZE, cursor } }
      );
      const users: Recipient[] = page.page
        .filter((u) => typeof u.email === "string" && u.email.length > 0)
        .map((u) => ({ userId: String(u._id), email: String(u.email) }));

      if (dryRun) {
        wouldSend += await ctx.runQuery(internal.announcements.countEligible, { key: args.key, users });
      } else {
        const batch = await ctx.runMutation(internal.announcements.claim, { key: args.key, users });
        if (batch.length > 0) {
          const result = await sendBatch(ctx, args.key, announcement, batch, apiKey!, replyTo!);
          totals.sent += result.sent;
          totals.failed += result.failed;
          await new Promise((resolve) => setTimeout(resolve, BATCH_SPACING_MS));
        }
      }

      if (page.isDone) break;
      cursor = page.continueCursor;

      if (!dryRun && Date.now() - started > RUN_BUDGET_MS) {
        await ctx.scheduler.runAfter(0, internal.announcements.send, { key: args.key, dryRun: false, cursor });
        console.log(`[announcements] ${args.key} continuing in a new run`, totals);
        return { dryRun, ...totals, continued: true };
      }
    }

    console.log(`[announcements] ${args.key} done`, dryRun ? { wouldSend } : totals);
    return dryRun ? { dryRun, wouldSend } : { dryRun, ...totals, continued: false };
  },
});
