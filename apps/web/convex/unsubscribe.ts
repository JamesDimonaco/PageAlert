import { v } from "convex/values";
import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { esc } from "./emails";

/**
 * One-click unsubscribe from product announcements (RFC 8058).
 *
 * The token is an HMAC of the user id under UNSUBSCRIBE_SECRET, not under
 * BETTER_AUTH_SECRET: rotating the auth secret should not silently kill the
 * unsubscribe link in every email already sitting in someone's inbox, and a
 * leaked link-signing key should not also be a session-signing key.
 */

const encoder = new TextEncoder();

async function hmacKey(usage: "sign" | "verify"): Promise<CryptoKey> {
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret) throw new Error("UNSUBSCRIBE_SECRET not configured");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

const message = (userId: string) => encoder.encode(`unsubscribe:${userId}`);

export async function signUnsubscribeToken(userId: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey("sign"), message(userId));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyUnsubscribeToken(userId: string, token: string): Promise<boolean> {
  if (!/^(?:[0-9a-f]{2})+$/.test(token)) return false;
  const sig = new Uint8Array(token.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", await hmacKey("verify"), sig, message(userId));
}

export async function unsubscribeUrl(userId: string): Promise<string> {
  const site = process.env.CONVEX_SITE_URL;
  if (!site) throw new Error("CONVEX_SITE_URL not set");
  return `${site}/unsubscribe?u=${encodeURIComponent(userId)}&t=${await signUnsubscribeToken(userId)}`;
}

export const optOut = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const existing = await ctx.db
      .query("productUpdateOptOuts")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    if (!existing) await ctx.db.insert("productUpdateOptOuts", { userId, optedOutAt: Date.now() });
  },
});

export const optedOutAmong = internalQuery({
  args: { userIds: v.array(v.string()) },
  handler: async (ctx, { userIds }) => {
    const out: string[] = [];
    for (const userId of userIds) {
      const row = await ctx.db
        .query("productUpdateOptOuts")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .first();
      if (row) out.push(userId);
    }
    return out;
  },
});

function page(status: number, heading: string, body: string, form?: string): Response {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(heading)} | PageAlert</title></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0a0a0b">
  <div style="max-width:480px;margin:64px auto;padding:32px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
    <h1 style="margin:0 0 12px;font-size:20px">${esc(heading)}</h1>
    <p style="margin:0 0 24px;color:#444;font-size:15px;line-height:1.55">${esc(body)}</p>
    ${form ?? ""}
  </div>
</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export const handler = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get("u") ?? "";
  const token = url.searchParams.get("t") ?? "";
  if (!userId || !(await verifyUnsubscribeToken(userId, token))) {
    return page(400, "This link is not valid", "It may have been cut short when it was copied. Open the link from the original email again.");
  }

  // GET only asks. Mail scanners follow links, and one that unsubscribed on
  // GET would opt people out who never clicked.
  if (request.method === "GET") {
    return page(
      200,
      "Unsubscribe from product updates?",
      "You will stop getting announcements about new PageAlert features. Alerts for your monitors are not affected.",
      `<form method="POST" action="${esc(`${url.pathname}${url.search}`)}"><button type="submit" style="background:#3b82f6;color:#fff;border:0;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;cursor:pointer">Unsubscribe</button></form>`
    );
  }

  await ctx.runMutation(internal.unsubscribe.optOut, { userId });
  return page(200, "You are unsubscribed", "You will not get any more product announcements from PageAlert. Alerts for your monitors keep working as before.");
});
