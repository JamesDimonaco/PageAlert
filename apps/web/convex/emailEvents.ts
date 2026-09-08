import { v } from "convex/values";
import { httpAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Delivery tracking for everything we send through Resend.
 *
 * `recordSend` writes a row the moment a send is attempted; the webhook below
 * advances that row when Resend reports what happened to it. Before this, a
 * bounced address and a delivered one were indistinguishable — sends are
 * fire-and-forget and the prod API key is send-only.
 */

const HOUR = 60 * 60 * 1000;

export const recordSend = internalMutation({
  args: {
    to: v.string(),
    kind: v.string(),
    userId: v.optional(v.string()),
    monitorId: v.optional(v.string()),
    resendId: v.optional(v.string()),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { ok, ...args }) => {
    const now = Date.now();
    await ctx.db.insert("emailSends", {
      ...args,
      status: ok ? "sent" : "failed",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Advance a send row from a Resend delivery event. Unknown ids are ignored. */
export const applyEvent = internalMutation({
  args: {
    resendId: v.string(),
    status: v.union(v.literal("delivered"), v.literal("bounced"), v.literal("complained")),
  },
  handler: async (ctx, { resendId, status }) => {
    const row = await ctx.db
      .query("emailSends")
      .withIndex("by_resendId", (q) => q.eq("resendId", resendId))
      .unique();
    if (!row) return "unknown";
    // A delivered event can arrive after a bounce for the same id on some
    // providers. Never walk a failure back to a success.
    if (status === "delivered" && row.status !== "sent") return "applied";
    await ctx.db.patch(row._id, { status, updatedAt: Date.now() });

    if (status === "bounced" || status === "complained") {
      // Volume is low enough that a single bounce is worth knowing about, so
      // alert on any of them and let claimAlertSlot keep it to one an hour.
      const send = await ctx.runMutation(internal.admin.claimAlertSlot, {
        key: "admin:email-bounce",
        minIntervalMs: HOUR,
      });
      if (send) {
        await ctx.scheduler.runAfter(0, internal.admin.notify, {
          text: `PageAlert: email ${status} for ${row.to} (${row.kind}). Check Resend for more.`,
        });
      }
    }
    return "applied";
  },
});

/**
 * Resend signs webhooks with Svix: base64 HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${rawBody}`, keyed by the base64 body of the
 * `whsec_` secret. The header carries a space-separated list of
 * `<version>,<signature>` pairs so a secret can be rotated without downtime.
 */
function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buffer;
}

async function verifySvix(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  body: string
): Promise<boolean | null> {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      base64ToBuffer(raw),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
  } catch {
    // A malformed RESEND_WEBHOOK_SECRET is a config fault, not a bad request.
    // Throwing here would 500 and make Resend retry a request that can never
    // succeed.
    console.error("[email-events] RESEND_WEBHOOK_SECRET is not valid base64");
    return null;
  }
  const message = new TextEncoder().encode(`${svixId}.${svixTimestamp}.${body}`);

  for (const part of svixSignature.split(" ")) {
    const [, sig] = part.split(",");
    if (!sig) continue;
    let sigBytes: ArrayBuffer;
    try {
      sigBytes = base64ToBuffer(sig);
    } catch {
      continue;
    }
    // crypto.subtle.verify compares in constant time.
    if (await crypto.subtle.verify("HMAC", key, sigBytes, message)) return true;
  }
  return false;
}

const EVENT_STATUS: Record<string, "delivered" | "bounced" | "complained"> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

/** Five minutes, matching Svix's own replay window. */
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/** How long an unmatched event is treated as a race rather than a stranger. */
const UNKNOWN_ID_RETRY_WINDOW_MS = 60 * 1000;

export const handler = httpAction(async (ctx, request) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook secret not configured", { status: 503 });

  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response("Missing signature headers", { status: 401 });
  }

  const age = Date.now() - Number(svixTimestamp) * 1000;
  if (!Number.isFinite(age) || Math.abs(age) > MAX_SIGNATURE_AGE_MS) {
    return new Response("Signature timestamp out of range", { status: 401 });
  }

  // Must be the exact bytes that were signed, so read the body as text and
  // parse afterwards.
  const body = await request.text();
  const verified = await verifySvix(secret, svixId, svixTimestamp, svixSignature, body);
  if (verified === null) return new Response("Webhook secret is malformed", { status: 503 });
  if (!verified) return new Response("Unauthorized", { status: 401 });

  let payload: { type?: string; data?: { email_id?: string } };
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const status = EVENT_STATUS[payload.type ?? ""];
  const resendId = payload.data?.email_id;
  // 200 on event types we don't track, or Resend retries them forever.
  if (!status || !resendId) return new Response("OK", { status: 200 });

  const result = await ctx.runMutation(internal.emailEvents.applyEvent, { resendId, status });
  if (result === "unknown") {
    // The send row is written after Resend's POST returns, so a fast bounce can
    // beat it here. Ask for a retry while that is still plausible; past the
    // window the id is genuinely one we never recorded, and retrying forever
    // would just make noise.
    const raced = Date.now() - Number(svixTimestamp) * 1000 < UNKNOWN_ID_RETRY_WINDOW_MS;
    console.warn("[email-events] no send row for", resendId, raced ? "— asking for a retry" : "— giving up");
    if (raced) return new Response("Send not recorded yet", { status: 503 });
  }
  return new Response("OK", { status: 200 });
});
