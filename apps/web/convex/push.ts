"use node";

import { v } from "convex/values";
import webpush from "web-push";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Web push delivery. Runs in Node because VAPID signing needs crypto the
 * default Convex isolate doesn't carry; the subscription rows themselves live
 * in convex/pushSubscriptions.ts, which a Node file can't hold.
 *
 * Unlike Telegram and Discord there is no per-user target to look up — a user
 * has as many endpoints as devices, and every live one gets the message.
 */

const APP_URL = process.env.SITE_URL ?? "https://pagealert.io";

class PushNotConfiguredError extends Error {
  constructor() {
    super("Push isn't configured on this deployment yet");
  }
}

function configure(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    console.error("[push] VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY not configured");
    return false;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? `mailto:support@pagealert.io`,
    publicKey,
    privateKey
  );
  return true;
}

interface Payload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

async function deliver(
  ctx: ActionCtx,
  userId: string,
  payload: Payload
): Promise<number> {
  if (!configure()) return 0;

  const subs = await ctx.runQuery(internal.pushSubscriptions.listForUser, { userId });
  if (subs.length === 0) return 0;

  const body = JSON.stringify(payload);
  let delivered = 0;

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body
        );
        delivered++;
      } catch (err) {
        // 404/410 mean the browser threw this subscription away — the user
        // cleared site data, uninstalled, or revoked permission. Keeping the
        // row would mean paying for a failed send on every future alert.
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          await ctx.runMutation(internal.pushSubscriptions.deleteByEndpoint, {
            endpoint: sub.endpoint,
          });
        } else {
          console.error("[push] send failed", status ?? err);
        }
      }
    })
  );

  return delivered;
}

/**
 * Push one alert to every device a user has registered.
 *
 * Takes a finished title and body rather than the per-alert argument shapes
 * the other channels use. A notification is a headline and a line of text
 * whatever produced it, and every dispatch site already builds exactly that
 * pair for the in-app notification.
 */
export const sendToUser = internalAction({
  args: {
    userId: v.string(),
    title: v.string(),
    body: v.string(),
    monitorId: v.string(),
    // Collapses repeat alerts of the same kind for one monitor instead of
    // stacking them on the lock screen. Kinds are kept apart: a match and a
    // price change from one check are two things the user wants to see.
    kind: v.optional(v.union(v.literal("match"), v.literal("price"), v.literal("error"))),
  },
  handler: async (ctx, args) => {
    await deliver(ctx, args.userId, {
      title: args.title,
      body: args.body,
      url: `${APP_URL}/dashboard/monitors/${args.monitorId}`,
      tag: `${args.monitorId}:${args.kind ?? "alert"}`,
    });
  },
});

/** Fire a test notification at the caller's own devices */
export const sendTestMessage = action({
  args: {},
  handler: async (ctx): Promise<{ delivered: number }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      throw new PushNotConfiguredError();
    }

    const delivered = await deliver(ctx, identity.subject, {
      title: "PageAlert",
      body: "Push notifications are working. This is what an alert will look like.",
      url: `${APP_URL}/dashboard`,
      tag: "pagealert-test",
    });

    if (delivered === 0) {
      throw new Error(
        "No device received the notification. Try turning push off and on again."
      );
    }
    return { delivered };
  },
});
