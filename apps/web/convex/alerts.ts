import type { ActionCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";

/**
 * Which channels an alert goes out on. No list means every channel, except
 * texts. Those are opt-in per monitor: every monitor made before the field
 * existed has no list, so the shared rule would start texting for all of
 * them the moment a user verified a number.
 */
export function alertChannels(notificationChannels: string[] | undefined) {
  return {
    shouldSend: (channel: string) => !notificationChannels || notificationChannels.includes(channel),
    shouldSendSms: notificationChannels?.includes("sms") === true,
    hasAnyChannel: !notificationChannels || notificationChannels.length > 0,
  };
}

/**
 * One alert, worded for each channel. The channel senders take different
 * arguments, so each target gets a function that makes its own call.
 */
export type AlertMessages = {
  /** Sent to PostHog as `alert_sent`'s type. */
  type: "match" | "stock";
  title: string;
  inAppMessage: string;
  pushBody: string;
  email: (to: string) => Promise<unknown>;
  telegram: (chatId: string) => Promise<unknown>;
  discord: (webhookUrl: string) => Promise<unknown>;
  /** Left out where an alert has never been texted. */
  sms?: (phone: string) => Promise<unknown>;
};

/**
 * Send one alert on every channel the monitor allows. The caller has already
 * checked mute. A failing channel is logged and skipped, so one bad webhook
 * cannot stop the rest. `alert_sent` is counted only if a channel delivered.
 */
export async function deliverAlert(ctx: ActionCtx, monitor: Doc<"monitors">, alert: AlertMessages): Promise<void> {
  const { shouldSend, shouldSendSms, hasAnyChannel } = alertChannels(monitor.notificationChannels);
  if (!hasAnyChannel) return;
  let delivered = false;
  const logFailure = (channel: string) => (e: unknown) =>
    console.error(`[alerts] ${alert.type} ${channel} failed for ${monitor._id}:`, e instanceof Error ? e.message : e);
  const send = (channel: string, attempt: Promise<unknown>) =>
    attempt.then(() => { delivered = true; }, logFailure(channel));
  const setting = (channel: "telegram" | "discord" | "sms") =>
    ctx.runQuery(internal.scheduler.getNotificationSetting, { userId: monitor.userId, channel });

  await send("in-app", ctx.runMutation(internal.userNotifications.create, {
    userId: monitor.userId,
    monitorId: monitor._id,
    channel: "in_app",
    title: alert.title,
    message: alert.inAppMessage,
  }));

  if (shouldSend("push")) {
    await send("push", ctx.runAction(internal.push.sendToUser, {
      userId: monitor.userId,
      monitorId: monitor._id,
      title: alert.title,
      body: alert.pushBody,
      kind: alert.type,
    }));
  }

  if (shouldSend("email") && monitor.userEmail) {
    await send("email", alert.email(monitor.userEmail));
  }

  if (shouldSend("telegram")) {
    const telegram = await setting("telegram");
    if (telegram?.enabled && telegram.target) await send("telegram", alert.telegram(telegram.target));
  }

  if (shouldSend("discord")) {
    const discord = await setting("discord");
    if (discord?.enabled && discord.target) await send("discord", alert.discord(discord.target));
  }

  // The allowance check lives inside sms.ts, so a refusal there is silent by
  // design — the other channels have already gone.
  if (alert.sms && shouldSendSms) {
    const sms = await setting("sms");
    if (sms?.enabled && sms.target) await send("sms", alert.sms(sms.target));
  }

  if (!delivered) return;
  await ctx.scheduler.runAfter(0, internal.analytics.capture, {
    distinctId: monitor.userId,
    event: "alert_sent",
    properties: { type: alert.type, monitor_id: monitor._id },
  });
}
