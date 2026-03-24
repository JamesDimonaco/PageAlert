import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";

const FROM_EMAIL = "Prowl <alerts@pagealert.io>";
const APP_URL = process.env.SITE_URL ?? "https://prowl-web-eta.vercel.app";

/** Get user email from Better Auth's user table (in the component) */
export const getUserEmail = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    // Better Auth stores users in the betterAuth component's "user" table
    // The userId is the subject from the JWT which maps to the user's _id
    // We need to look up the user through the auth component
    const identity = await ctx.auth.getUserIdentity();
    // For scheduled jobs, we don't have auth context — we need the email
    // stored on the monitor or passed through. Return null here.
    return null;
  },
});

/** Send a match alert email */
export const sendMatchAlert = internalAction({
  args: {
    to: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    url: v.string(),
    matchCount: v.number(),
    matches: v.array(v.any()),
    totalItems: v.number(),
  },
  handler: async (_ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[email] RESEND_API_KEY not configured, skipping email");
      return;
    }

    const matchList = args.matches
      .slice(0, 5)
      .map((m: Record<string, unknown>) => {
        const title = String(m.title ?? m.name ?? "Unknown item");
        const price = m.price != null ? ` — $${Number(m.price).toLocaleString()}` : "";
        return `<li style="padding:8px 0;border-bottom:1px solid #eee">${title}${price}</li>`;
      })
      .join("");

    const moreText = args.matchCount > 5 ? `<p style="color:#666;font-size:14px">+${args.matchCount - 5} more matches</p>` : "";

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
      <!-- Header -->
      <div style="background:#4f46e5;padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600">Match Found!</h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:14px">${args.monitorName}</p>
      </div>

      <!-- Content -->
      <div style="padding:32px">
        <p style="margin:0 0 16px;color:#333;font-size:16px">
          Your monitor found <strong>${args.matchCount} match${args.matchCount !== 1 ? "es" : ""}</strong> out of ${args.totalItems} items on
          <a href="${args.url}" style="color:#4f46e5;text-decoration:none">${new URL(args.url).hostname}</a>.
        </p>

        <ul style="list-style:none;padding:0;margin:0 0 16px">
          ${matchList}
        </ul>
        ${moreText}

        <!-- CTA buttons -->
        <div style="margin-top:24px">
          <a href="${args.url}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px;margin-right:8px">
            View on site
          </a>
          <a href="${APP_URL}/dashboard/monitors/${args.monitorId}" style="display:inline-block;background:#f4f4f5;color:#333;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px">
            View in Prowl
          </a>
        </div>
      </div>

      <!-- Footer -->
      <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #eee">
        <p style="margin:0;color:#999;font-size:12px">
          You're receiving this because you have an active monitor on Prowl.
          <a href="${APP_URL}/dashboard/settings" style="color:#999">Manage notifications</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;

    const text = `Match Found — ${args.monitorName}

Your monitor found ${args.matchCount} match${args.matchCount !== 1 ? "es" : ""} out of ${args.totalItems} items on ${new URL(args.url).hostname}.

${args.matches.slice(0, 5).map((m: Record<string, unknown>) => `• ${String(m.title ?? m.name ?? "Unknown")}${m.price != null ? ` — $${Number(m.price)}` : ""}`).join("\n")}
${args.matchCount > 5 ? `+${args.matchCount - 5} more` : ""}

View on site: ${args.url}
View in Prowl: ${APP_URL}/dashboard/monitors/${args.monitorId}

Manage notifications: ${APP_URL}/dashboard/settings`;

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [args.to],
          subject: `Match found: ${args.monitorName}`,
          html,
          text,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.error("[email] Resend API error:", res.status, body);
        return;
      }

      const data = await res.json();
      console.log("[email] Sent match alert to", args.to, "id:", data.id);
    } catch (e) {
      console.error("[email] Failed to send:", e instanceof Error ? e.message : e);
    }
  },
});

/** Send an error alert email */
export const sendErrorAlert = internalAction({
  args: {
    to: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    url: v.string(),
    error: v.string(),
  },
  handler: async (_ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
      <div style="background:#ef4444;padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600">Monitor Error</h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:14px">${args.monitorName}</p>
      </div>
      <div style="padding:32px">
        <p style="margin:0 0 16px;color:#333;font-size:16px">
          Your monitor for <a href="${args.url}" style="color:#4f46e5;text-decoration:none">${new URL(args.url).hostname}</a>
          has stopped working after multiple retries.
        </p>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin-bottom:24px">
          <p style="margin:0;color:#991b1b;font-size:14px">${args.error}</p>
        </div>
        <a href="${APP_URL}/dashboard/monitors/${args.monitorId}" style="display:inline-block;background:#ef4444;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px">
          Check Monitor
        </a>
      </div>
      <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #eee">
        <p style="margin:0;color:#999;font-size:12px">
          <a href="${APP_URL}/dashboard/settings" style="color:#999">Manage notifications</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;

    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [args.to],
          subject: `Monitor error: ${args.monitorName}`,
          html,
          text: `Monitor Error — ${args.monitorName}\n\n${args.error}\n\nCheck your monitor: ${APP_URL}/dashboard/monitors/${args.monitorId}`,
        }),
      });
    } catch (e) {
      console.error("[email] Failed to send error alert:", e instanceof Error ? e.message : e);
    }
  },
});
