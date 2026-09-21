import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  action,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { effectiveTier } from "./tiers";
import {
  formatMatchSms,
  formatPriceSms,
  formatQuotaExhaustedSms,
  formatVerificationSms,
} from "@prowl/shared";

/**
 * Text-message alerts.
 *
 * The channel most users actually want — no app to install, no account to make
 * — and the only one that costs money per send. Two consequences run through
 * this file. Every send passes through tiers.reserveSmsSend first, and no
 * number becomes a destination until a code sent to it comes back.
 *
 * SMS deliberately carries match and price alerts only. Errors, parks and
 * inactivity pauses stay on email: they are not worth 160 characters and a
 * push notification at 3am, and a monitor that starts failing would otherwise
 * spend a user's whole allowance telling them so.
 */

const APP_URL = process.env.SITE_URL ?? "https://pagealert.io";
const TIMEOUT = 10_000;

/** Off until the Twilio console guards are in place — see .env.example. */
function smsEnabled(): boolean {
  return process.env.SMS_ENABLED === "true";
}

/**
 * Whether to offer text alerts in the UI at all.
 *
 * A query rather than a NEXT_PUBLIC_ twin because SMS_ENABLED is read inside
 * Convex actions, and two copies of a kill switch drift. Without this the
 * settings card ships visible and errors on every click for as long as the
 * flag is off.
 */
export const isEnabled = query({
  args: {},
  handler: async () => smsEnabled(),
});

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
}

/**
 * A Messaging Service rather than a bare `From`, so the sender pool can change
 * — an alphanumeric sender ID today, a long code once a country needs one —
 * without a deploy.
 */
function twilioConfig(): TwilioConfig {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!accountSid || !authToken || !messagingServiceSid) {
    throw new Error("Twilio is not configured");
  }
  return { accountSid, authToken, messagingServiceSid };
}

// ---- Destinations ----

/**
 * Countries we will text, by dialling code.
 *
 * An allowlist rather than a blocklist because the failure mode is paying for
 * traffic to a premium-rate destination someone set up to bill us. This list
 * is the cheap in-code guard; the one that actually holds is Twilio's Geo
 * Permissions, which has to be narrowed to match before SMS_ENABLED goes on.
 *
 * UK and EU only at launch. The US and Canada are absent on purpose: they ban
 * alphanumeric sender IDs, so reaching them means a toll-free number and a
 * verification that takes weeks.
 */
const ALLOWED_DIAL_CODES = [
  "44", // United Kingdom
  "353", // Ireland
  "33", // France
  "49", // Germany
  "34", // Spain
  "39", // Italy
  "351", // Portugal
  "31", // Netherlands
  "32", // Belgium
  "352", // Luxembourg
  "43", // Austria
  "41", // Switzerland
  "45", // Denmark
  "46", // Sweden
  "47", // Norway
  "358", // Finland
  "354", // Iceland
  "48", // Poland
  "420", // Czechia
  "421", // Slovakia
  "36", // Hungary
  "40", // Romania
  "359", // Bulgaria
  "385", // Croatia
  "386", // Slovenia
  "372", // Estonia
  "371", // Latvia
  "370", // Lithuania
  "30", // Greece
  "357", // Cyprus
  "356", // Malta
];

export class PhoneError extends Error {}

/**
 * Turn what someone typed into E.164, or explain why it cannot be.
 *
 * Deliberately refuses to guess a country from a national number: "07911
 * 123456" is a valid mobile in several places and picking one silently would
 * text a stranger.
 */
export function normalisePhone(input: string): string {
  const raw = input.trim();
  let digits = raw.replace(/[^\d+]/g, "");

  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  if (!digits.startsWith("+")) digits = `+${digits}`;
  const body = digits.slice(1);

  if (!/^\d+$/.test(body)) throw new PhoneError("Enter digits only, starting with your country code");
  if (body.startsWith("0")) {
    throw new PhoneError("Start with your country code (44 for the UK), not 0");
  }
  if (body.length < 7 || body.length > 15) throw new PhoneError("That does not look like a phone number");

  // Longest match wins, so a three-digit code is never mistaken for a
  // two-digit one that happens to share its opening digits.
  const code = [...ALLOWED_DIAL_CODES]
    .sort((a, b) => b.length - a.length)
    .find((c) => body.startsWith(c));
  if (!code) {
    throw new PhoneError("We can only text UK and EU numbers at the moment. Email and Telegram work everywhere.");
  }

  return `+${body}`;
}

/** The last four digits, for showing a number back without printing it. */
export function maskPhone(phone: string): string {
  return `••• ••• ${phone.slice(-4)}`;
}

// ---- Sending ----

async function postToTwilio(to: string, body: string): Promise<void> {
  const { accountSid, authToken, messagingServiceSid } = twilioConfig();

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, MessagingServiceSid: messagingServiceSid, Body: body }),
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[sms] Send failed:", res.status, text);
    throw new Error("Failed to send SMS");
  }
  console.log(`[sms] sent to ${maskPhone(to)} (${body.length} chars)`);
}

/**
 * Reserve an allowance slot, then send. Returns whether anything went out.
 *
 * A refusal is not an error: the user has simply had their texts for the
 * period, and the email alert has already gone. The one refusal that still
 * sends is the notice saying so, which is why it is handled here rather than
 * by each caller.
 */
async function sendAlert(
  ctx: ActionCtx,
  userId: string,
  to: string,
  body: string,
): Promise<boolean> {
  if (!smsEnabled()) {
    console.log("[sms] SMS_ENABLED is not true — skipping send");
    return false;
  }

  const reservation = await ctx.runMutation(internal.tiers.reserveSmsSend, { userId });

  if (!reservation.ok) {
    if (reservation.notifyExhausted) {
      await postToTwilio(
        to,
        formatQuotaExhaustedSms(reservation.monthLimit, `${APP_URL}/dashboard/settings`),
      );
      return true;
    }
    console.log(`[sms] refused for ${userId}: ${reservation.reason}`);
    return false;
  }

  await postToTwilio(to, body);
  return true;
}

export const sendMatchAlert = internalAction({
  args: {
    userId: v.string(),
    phone: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    matchCount: v.number(),
  },
  handler: async (ctx, args) => {
    await sendAlert(
      ctx,
      args.userId,
      args.phone,
      formatMatchSms({
        monitorName: args.monitorName,
        newCount: args.matchCount,
        link: `${APP_URL}/m/${args.monitorId}`,
      }),
    );
  },
});

export const sendPriceAlert = internalAction({
  args: {
    userId: v.string(),
    phone: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    variant: v.union(v.literal("threshold"), v.literal("single_drop"), v.literal("multiple")),
    changes: v.array(
      v.object({
        title: v.string(),
        oldPrice: v.number(),
        newPrice: v.number(),
        changePercent: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await sendAlert(
      ctx,
      args.userId,
      args.phone,
      formatPriceSms({
        monitorName: args.monitorName,
        variant: args.variant,
        changes: args.changes,
        link: `${APP_URL}/m/${args.monitorId}`,
      }),
    );
  },
});

// ---- Verification ----

/** Wrong guesses before the code is burned. */
const MAX_CODE_ATTEMPTS = 5;
/** Codes one account may have sent in a day. The anti-pumping cap. */
const MAX_CODES_PER_DAY = 3;
const CODE_TTL_MS = 10 * 60 * 1000;

function sixDigits(): string {
  // crypto.getRandomValues over Math.random: the code is the only thing
  // standing between an attacker and someone else's phone as a destination.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0]! % 1_000_000).padStart(6, "0");
}

/**
 * Record a pending verification and hand back the code to send.
 *
 * The daily cap lives here rather than in the action so that two parallel
 * requests cannot both read "2 sent today" and both send a third.
 */
export const claimVerification = internalMutation({
  args: { userId: v.string(), phone: v.string() },
  handler: async (ctx, { userId, phone }) => {
    const today = new Date().toISOString().slice(0, 10);
    const existing = await ctx.db
      .query("phoneVerifications")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    const sentToday = existing?.sentDate === today ? existing.sentCount : 0;
    if (sentToday >= MAX_CODES_PER_DAY) {
      throw new Error(`That is ${MAX_CODES_PER_DAY} codes today. Try again tomorrow.`);
    }

    const code = sixDigits();
    const row = {
      userId,
      phone,
      code,
      expiresAt: Date.now() + CODE_TTL_MS,
      attempts: 0,
      sentCount: sentToday + 1,
      sentDate: today,
    };

    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("phoneVerifications", row);

    return code;
  },
});

/** Send a code to a number the user wants alerts on. */
export const startVerification = action({
  args: { phone: v.string() },
  handler: async (ctx, args): Promise<{ sent: true; phone: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    if (!smsEnabled()) throw new Error("Text alerts are not available yet");

    let phone: string;
    try {
      phone = normalisePhone(args.phone);
    } catch (e) {
      throw new Error(e instanceof PhoneError ? e.message : "That does not look like a phone number");
    }

    const code: string = await ctx.runMutation(internal.sms.claimVerification, {
      userId: identity.subject,
      phone,
    });

    await postToTwilio(phone, formatVerificationSms(code));
    return { sent: true, phone: maskPhone(phone) };
  },
});

/**
 * Check the code and, if it matches, make the number a destination.
 *
 * Writes the notificationSettings row directly rather than going through
 * notificationSettings.upsert — that mutation refuses "sms" on purpose, so
 * this handshake is the only way a number can become one.
 */
export const confirmVerification = mutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = identity.subject;

    const pending = await ctx.db
      .query("phoneVerifications")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    if (!pending) throw new Error("Ask for a code first");
    if (pending.expiresAt < Date.now()) {
      await ctx.db.delete(pending._id);
      throw new Error("That code has expired. Ask for a new one.");
    }
    if (pending.attempts >= MAX_CODE_ATTEMPTS) {
      await ctx.db.delete(pending._id);
      throw new Error("Too many wrong codes. Ask for a new one.");
    }
    if (pending.code !== args.code.trim()) {
      await ctx.db.patch(pending._id, { attempts: pending.attempts + 1 });
      const left = MAX_CODE_ATTEMPTS - pending.attempts - 1;
      throw new Error(left > 0 ? `That code is wrong — ${left} attempts left` : "That code is wrong");
    }

    // One phone, one free account. Same rule as Telegram and Discord: without
    // it a free allowance is a per-signup allowance.
    if ((await tierOf(ctx, userId)) === "free") {
      const claim = await ctx.db
        .query("channelClaims")
        .withIndex("by_channel_target", (q) => q.eq("channel", "sms").eq("target", pending.phone))
        .unique();
      if (claim && claim.userId !== userId) {
        await ctx.db.delete(pending._id);
        throw new Error("That number is already in use on another free account");
      }
      if (!claim) {
        const mine = await ctx.db
          .query("channelClaims")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .collect();
        for (const c of mine) if (c.channel === "sms") await ctx.db.delete(c._id);
        await ctx.db.insert("channelClaims", {
          channel: "sms",
          target: pending.phone,
          userId,
          claimedAt: Date.now(),
        });
      }
    }

    const existing = await ctx.db
      .query("notificationSettings")
      .withIndex("by_userId_channel", (q) => q.eq("userId", userId).eq("channel", "sms"))
      .unique();

    if (existing) await ctx.db.patch(existing._id, { enabled: true, target: pending.phone });
    else await ctx.db.insert("notificationSettings", { userId, channel: "sms", enabled: true, target: pending.phone });

    await ctx.db.delete(pending._id);
    return { phone: maskPhone(pending.phone) };
  },
});

async function tierOf(ctx: MutationCtx, userId: string) {
  const record = await ctx.db
    .query("userTiers")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  return effectiveTier(record);
}
