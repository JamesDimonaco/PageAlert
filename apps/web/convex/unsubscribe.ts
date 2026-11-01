import { v } from "convex/values";
import { httpAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { esc } from "./shared";
import { emailCategory, type EmailCategory } from "./schema";

/**
 * One-click unsubscribe (RFC 8058), one email category at a time.
 *
 * The token is an HMAC of the user id under UNSUBSCRIBE_SECRET, not under
 * BETTER_AUTH_SECRET: rotating the auth secret should not silently kill the
 * unsubscribe link in every email already sitting in someone's inbox, and a
 * leaked link-signing key should not also be a session-signing key.
 *
 * The category rides unsigned beside the token. Whoever holds the link is the
 * recipient, and the page offers them every category anyway.
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

export async function unsubscribeUrl(userId: string, category: EmailCategory): Promise<string> {
  const site = process.env.CONVEX_SITE_URL;
  if (!site) throw new Error("CONVEX_SITE_URL not set");
  return `${site}/unsubscribe?u=${encodeURIComponent(userId)}&c=${category}&t=${await signUnsubscribeToken(userId)}`;
}

/** RFC 8058 one-click headers for an email carrying this unsubscribe link. */
export function unsubscribeHeaders(link: string): Record<string, string> {
  return { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

const ALL_CATEGORIES: EmailCategory[] = ["tips", "updates"];
const isCategory = (c: string): c is EmailCategory => (ALL_CATEGORIES as string[]).includes(c);

const LABEL: Record<EmailCategory, string> = {
  tips: "tips and getting-started emails",
  updates: "product updates",
};

export async function isOptedOut(ctx: QueryCtx, userId: string, category: EmailCategory): Promise<boolean> {
  const row = await ctx.db
    .query("emailOptOuts")
    .withIndex("by_userId_and_category", (q) => q.eq("userId", userId).eq("category", category))
    .first();
  return row !== null;
}

export const optOut = internalMutation({
  args: { userId: v.string(), categories: v.array(emailCategory) },
  handler: async (ctx, { userId, categories }) => {
    for (const category of categories) {
      if (!(await isOptedOut(ctx, userId, category))) {
        await ctx.db.insert("emailOptOuts", { userId, category, optedOutAt: Date.now() });
      }
    }
  },
});

export const optedOutAmong = internalQuery({
  args: { userIds: v.array(v.string()), category: emailCategory },
  handler: async (ctx, { userIds, category }) => {
    const out: string[] = [];
    for (const userId of userIds) {
      if (await isOptedOut(ctx, userId, category)) out.push(userId);
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

function button(action: string, label: string, primary: boolean): string {
  const style = primary
    ? "background:#3b82f6;color:#fff;border:0"
    : "background:#fff;color:#3b82f6;border:1px solid #3b82f6";
  return `<form method="POST" action="${esc(action)}" style="margin:0 0 12px"><button type="submit" style="${style};padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;cursor:pointer;width:100%">${esc(label)}</button></form>`;
}

export const handler = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get("u") ?? "";
  const token = url.searchParams.get("t") ?? "";
  // Links sent before categories existed carry no `c`, and only product
  // updates ever had a link.
  const c = url.searchParams.get("c") ?? "updates";
  if (!userId || !isCategory(c) || !(await verifyUnsubscribeToken(userId, token))) {
    return page(400, "This link is not valid", "It may have been cut short when it was copied. Open the link from the original email again.");
  }

  // GET only asks. Mail scanners follow links, and one that unsubscribed on
  // GET would opt people out who never clicked.
  if (request.method === "GET") {
    // Rebuilt from the verified parts, so a stray scope=all on the incoming
    // link cannot ride along on the single-category button.
    const action = `${url.pathname}?u=${encodeURIComponent(userId)}&c=${c}&t=${token}`;
    return page(
      200,
      `Unsubscribe from ${LABEL[c]}?`,
      "Alerts for your monitors are not affected.",
      button(action, "Unsubscribe", true) + button(`${action}&scope=all`, "Turn off all non-essential email", false)
    );
  }

  // A mail client's one-click POST hits the List-Unsubscribe URL, which has
  // no scope, so it only ever removes the one category.
  const all = url.searchParams.get("scope") === "all";
  await ctx.runMutation(internal.unsubscribe.optOut, { userId, categories: all ? ALL_CATEGORIES : [c] });
  return page(
    200,
    "You are unsubscribed",
    all
      ? "You will only get alerts for your monitors and essential account emails from now on."
      : `You will not get any more ${LABEL[c]}. Alerts for your monitors keep working as before.`
  );
});
