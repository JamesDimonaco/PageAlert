import { v } from "convex/values";
import { internalAction } from "./_generated/server";

const FROM_EMAIL = "PageAlert <alerts@pagealert.io>";
const APP_URL = process.env.SITE_URL ?? "https://pagealert.io";
const RESEND_TIMEOUT = 10_000;

/** HTML-escape untrusted strings to prevent injection */
function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

/** Validate URL for use in href attributes — block dangerous schemes */
function safeHref(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch { /* invalid URL */ }
  return "#";
}

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
      console.error("[email] RESEND_API_KEY not configured, skipping");
      return;
    }

    const safeName = esc(args.monitorName);
    const safeHost = esc(safeHostname(args.url));

    // Determine if this is a quick check (keyword-based) or full extraction
    const isQuickCheck = args.matches.length > 0 && (args.matches[0] as Record<string, unknown>)?.quickCheck === true;

    let matchList = "";
    let summaryText = "";

    if (isQuickCheck) {
      // Quick check: just say keywords were found on the page
      const kr = (args.matches[0] as Record<string, unknown>)?.keywordResults as Record<string, unknown> | undefined;
      const pr = (args.matches[0] as Record<string, unknown>)?.priceResults as Record<string, unknown> | undefined;
      const keywords = Array.isArray(kr?.included) ? (kr.included as string[]).join(", ") : "your keywords";
      const priceInfo = pr?.lowestInRange != null ? ` Prices from $${esc(Number(pr.lowestInRange).toLocaleString())}.` : "";
      summaryText = `Your monitor detected <strong>${esc(keywords)}</strong> on the page.${priceInfo}`;
    } else {
      // Full extraction: show matched items
      matchList = args.matches
        .slice(0, 5)
        .map((m: Record<string, unknown>) => {
          const title = esc(String(m.title ?? m.name ?? "Item"));
          const price = m.price != null ? ` — $${esc(Number(m.price).toLocaleString())}` : "";
          return `<li style="padding:8px 0;border-bottom:1px solid #eee">${title}${price}</li>`;
        })
        .join("");
      const itemsText = args.totalItems > 0 ? ` out of ${args.totalItems} items` : "";
      summaryText = `Your monitor found <strong>${args.matchCount} match${args.matchCount !== 1 ? "es" : ""}</strong>${itemsText} on <a href="${safeHref(args.url)}" style="color:#4f46e5;text-decoration:none">${safeHost}</a>.`;
    }

    const moreText = !isQuickCheck && args.matchCount > 5 ? `<p style="color:#666;font-size:14px">+${args.matchCount - 5} more matches</p>` : "";

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
      <div style="background:#4f46e5;padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600">Match Found!</h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:14px">${safeName}</p>
      </div>
      <div style="padding:32px">
        <p style="margin:0 0 16px;color:#333;font-size:16px">
          ${summaryText}
        </p>
        ${matchList ? `<ul style="list-style:none;padding:0;margin:0 0 16px">${matchList}</ul>` : ""}
        ${moreText}
        <div style="margin-top:24px">
          <a href="${safeHref(args.url)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px;margin-right:8px">View on site</a>
          <a href="${APP_URL}/dashboard/monitors/${args.monitorId}" style="display:inline-block;background:#f4f4f5;color:#333;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px">View in PageAlert</a>
        </div>
      </div>
      <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #eee">
        <p style="margin:0;color:#999;font-size:12px">
          You're receiving this because you have an active monitor on PageAlert.
          <a href="${APP_URL}/dashboard/settings" style="color:#999">Manage notifications</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;

    const plainItemsText = args.totalItems > 0 ? ` out of ${args.totalItems} items` : "";
    const text = isQuickCheck
      ? `Match Found — ${args.monitorName}\n\nYour monitor detected matching keywords on ${safeHostname(args.url)}.\n\nView on site: ${args.url}\nView in PageAlert: ${APP_URL}/dashboard/monitors/${args.monitorId}`
      : `Match Found — ${args.monitorName}\n\nYour monitor found ${args.matchCount} match${args.matchCount !== 1 ? "es" : ""}${plainItemsText} on ${safeHostname(args.url)}.\n\n${args.matches.slice(0, 5).map((m: Record<string, unknown>) => `• ${String(m.title ?? m.name ?? "Item")}${m.price != null ? ` — $${Number(m.price)}` : ""}`).join("\n")}\n${args.matchCount > 5 ? `+${args.matchCount - 5} more` : ""}\n\nView on site: ${args.url}\nView in PageAlert: ${APP_URL}/dashboard/monitors/${args.monitorId}`;

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
        signal: AbortSignal.timeout(RESEND_TIMEOUT),
      });

      if (!res.ok) {
        console.error("[email] Resend API error:", res.status, "monitor:", args.monitorId);
        return;
      }

      const data = await res.json();
      console.log("[email] Match alert sent, monitor:", args.monitorId, "resend_id:", data.id);
    } catch (e) {
      console.error("[email] Failed to send, monitor:", args.monitorId, e instanceof Error ? e.message : "");
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
    if (!apiKey) {
      console.error("[email] RESEND_API_KEY not configured, skipping");
      return;
    }

    const safeName = esc(args.monitorName);
    const safeHost = esc(safeHostname(args.url));
    const safeError = esc(args.error);

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
      <div style="background:#ef4444;padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600">Monitor Error</h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:14px">${safeName}</p>
      </div>
      <div style="padding:32px">
        <p style="margin:0 0 16px;color:#333;font-size:16px">
          Your monitor for <a href="${safeHref(args.url)}" style="color:#4f46e5;text-decoration:none">${safeHost}</a>
          has stopped working after multiple retries.
        </p>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin-bottom:24px">
          <p style="margin:0;color:#991b1b;font-size:14px">${safeError}</p>
        </div>
        <a href="${APP_URL}/dashboard/monitors/${args.monitorId}" style="display:inline-block;background:#ef4444;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px">Check Monitor</a>
      </div>
      <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #eee">
        <p style="margin:0;color:#999;font-size:12px"><a href="${APP_URL}/dashboard/settings" style="color:#999">Manage notifications</a></p>
      </div>
    </div>
  </div>
</body>
</html>`;

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
          subject: `Monitor error: ${args.monitorName}`,
          html,
          text: `Monitor Error — ${args.monitorName}\n\n${args.error}\n\nCheck your monitor: ${APP_URL}/dashboard/monitors/${args.monitorId}`,
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT),
      });

      if (!res.ok) {
        console.error("[email] Resend API error:", res.status, "monitor:", args.monitorId);
        return;
      }
      console.log("[email] Error alert sent, monitor:", args.monitorId);
    } catch (e) {
      console.error("[email] Error alert failed, monitor:", args.monitorId, e instanceof Error ? e.message : "");
    }
  },
});
