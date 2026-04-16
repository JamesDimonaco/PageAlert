import { v } from "convex/values";
import { internalAction } from "./_generated/server";

const FROM_EMAIL = "PageAlert <alerts@pagealert.io>";
// Onboarding/welcome emails come from a separate address so users can
// mentally distinguish marketing from the actual notifications they
// signed up for. Resend / DNS for hello@ is set up by James as part of
// PROWL-038 Phase 4.
const HELLO_FROM_EMAIL = "PageAlert <hello@pagealert.io>";
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
    tracksPrices: v.optional(v.boolean()),
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

    // Use the first matched item's URL if available, otherwise fall back to the monitor URL
    const firstItemUrl = !isQuickCheck
      ? args.matches.find((m: Record<string, unknown>) => typeof m.url === "string" && m.url.length > 0)?.url as string | undefined
      : undefined;
    const viewOnSiteUrl = firstItemUrl ?? args.url;

    let matchList = "";
    let summaryText = "";

    if (isQuickCheck) {
      // Quick check: just say keywords were found on the page
      const kr = (args.matches[0] as Record<string, unknown>)?.keywordResults as Record<string, unknown> | undefined;
      const pr = (args.matches[0] as Record<string, unknown>)?.priceResults as Record<string, unknown> | undefined;
      const keywords = Array.isArray(kr?.included) ? (kr.included as string[]).join(", ") : "your keywords";
      const lowestPrice = pr?.lowestInRange != null ? Number(pr.lowestInRange) : NaN;
      const priceInfo = Number.isFinite(lowestPrice) ? ` Prices from $${esc(lowestPrice.toLocaleString("en-US"))}.` : "";
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

    const priceDiscovery = args.tracksPrices
      ? `<div style="margin-top:24px;padding-top:24px;border-top:1px solid #eee">
          <p style="margin:0 0 8px;color:#333;font-size:14px">📊 This page has prices — want price drop alerts?</p>
          <p style="margin:0 0 12px;color:#666;font-size:13px">Set up price tracking to get notified when prices change.</p>
          <a href="${APP_URL}/dashboard/monitors/${args.monitorId}?section=price-alerts" style="color:#4f46e5;font-size:13px;font-weight:500;text-decoration:none">Set up price alerts →</a>
        </div>`
      : "";

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
          <a href="${safeHref(viewOnSiteUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px;margin-right:8px">View on site</a>
          <a href="${APP_URL}/dashboard/monitors/${args.monitorId}" style="display:inline-block;background:#f4f4f5;color:#333;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px">View in PageAlert</a>
        </div>
        ${priceDiscovery}
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
    const priceDiscoveryText = args.tracksPrices
      ? "\n\nThis page has prices — set up price tracking to get notified when prices change.\nSet up price alerts: " + `${APP_URL}/dashboard/monitors/${args.monitorId}?section=price-alerts`
      : "";
    const text = isQuickCheck
      ? `Match Found — ${args.monitorName}\n\nYour monitor detected matching keywords on ${safeHostname(args.url)}.\n\nView on site: ${viewOnSiteUrl}\nView in PageAlert: ${APP_URL}/dashboard/monitors/${args.monitorId}` + priceDiscoveryText
      : `Match Found — ${args.monitorName}\n\nYour monitor found ${args.matchCount} match${args.matchCount !== 1 ? "es" : ""}${plainItemsText} on ${safeHostname(args.url)}.\n\n${args.matches.slice(0, 5).map((m: Record<string, unknown>) => `• ${String(m.title ?? m.name ?? "Item")}${m.price != null ? ` — $${Number(m.price)}` : ""}`).join("\n")}\n${args.matchCount > 5 ? `+${args.matchCount - 5} more` : ""}\n\nView on site: ${viewOnSiteUrl}\nView in PageAlert: ${APP_URL}/dashboard/monitors/${args.monitorId}` + priceDiscoveryText;

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

/** Send scan complete email to anonymous user who gave their email */
export const sendAnonymousScanComplete = internalAction({
  args: {
    to: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    url: v.string(),
    matchCount: v.number(),
    totalItems: v.number(),
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
      <div style="background:#3b82f6;padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600">Your scan is ready!</h1>
      </div>
      <div style="padding:32px">
        <p style="margin:0 0 16px;color:#333;font-size:16px">
          We scanned <strong>${esc(args.monitorName)}</strong> and found <strong>${args.totalItems} items</strong>${args.matchCount > 0 ? ` with <strong>${args.matchCount} matches</strong>` : ""}.
        </p>
        <a href="${APP_URL}/try/${args.monitorId}" style="display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px">
          View Results
        </a>
        <p style="margin:24px 0 0;color:#666;font-size:14px">
          We'll check this page every 24 hours and email you when new matches appear.
        </p>
        <div style="margin-top:24px;padding-top:24px;border-top:1px solid #eee">
          <p style="margin:0;color:#666;font-size:14px">
            Want faster checks and more monitors?
          </p>
          <a href="${APP_URL}/login" style="display:inline-block;margin-top:12px;background:#f4f4f5;color:#333;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:500;font-size:13px;border:1px solid #ddd">
            Create a free account
          </a>
        </div>
      </div>
      <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #eee">
        <p style="margin:0;color:#999;font-size:12px">
          PageAlert — AI-powered website monitoring. <a href="${APP_URL}" style="color:#999">pagealert.io</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [args.to],
        subject: `PageAlert — Your scan of ${args.monitorName} is ready`,
        html,
        text: `Your scan is ready!\n\nWe found ${args.totalItems} items${args.matchCount > 0 ? ` with ${args.matchCount} matches` : ""} on ${args.monitorName}.\n\nView results: ${APP_URL}/try/${args.monitorId}\n\nWe'll check every 24 hours and email you when new matches appear.\n\nCreate a free account for more: ${APP_URL}/login`,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[emails] Anonymous scan email failed:", res.status, body);
    }
  },
});

/** Send a price alert email (single drop, multiple changes, or threshold hit) */
export const sendPriceAlert = internalAction({
  args: {
    to: v.string(),
    monitorName: v.string(),
    monitorId: v.string(),
    url: v.string(),
    variant: v.union(v.literal("threshold"), v.literal("single_drop"), v.literal("multiple")),
    priceChanges: v.array(v.object({
      title: v.string(),
      oldPrice: v.number(),
      newPrice: v.number(),
      change: v.number(),
      changePercent: v.number(),
    })),
    belowThreshold: v.optional(v.number()),
    aboveThreshold: v.optional(v.number()),
    belowHits: v.array(v.object({
      title: v.string(),
      oldPrice: v.number(),
      newPrice: v.number(),
      change: v.number(),
      changePercent: v.number(),
    })),
    aboveHits: v.array(v.object({
      title: v.string(),
      oldPrice: v.number(),
      newPrice: v.number(),
      change: v.number(),
      changePercent: v.number(),
    })),
    trackedItemCount: v.number(),
  },
  handler: async (_ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[email] RESEND_API_KEY not configured, skipping");
      return;
    }

    const fmt = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const pct = (n: number) => `${Math.abs(n).toFixed(1)}%`;
    const manageUrl = `${APP_URL}/dashboard/monitors/${args.monitorId}?section=price-alerts`;

    // Subject line
    const firstBelow = args.belowHits[0];
    const firstAbove = args.aboveHits[0];
    const firstHit = firstBelow ?? firstAbove;
    const firstChange = args.priceChanges[0];
    let subject: string;
    if (args.variant === "threshold" && firstHit) {
      const threshold = firstBelow ? args.belowThreshold : args.aboveThreshold;
      const direction = firstBelow ? "dropped below" : "rose above";
      subject = threshold != null
        ? `🎯 ${firstHit.title} ${direction} your ${fmt(threshold)} target!`
        : `🎯 ${firstHit.title} — price target hit!`;
    } else if (args.variant === "single_drop" && firstChange) {
      subject = `${firstChange.title} dropped to ${fmt(firstChange.newPrice)} (-${pct(firstChange.changePercent)})`;
    } else {
      subject = `Price alert: ${args.priceChanges.length} price changes on ${args.monitorName}`;
    }

    // Header config
    const isMultiple = args.variant === "multiple";
    const headerColor = isMultiple ? "#3b82f6" : "#10b981";
    const headerTitle = args.variant === "threshold" ? "Price Target Hit!" : isMultiple ? "Price Changes Detected" : "Price Drop";

    // Build price change row HTML
    const row = (item: { title: string; oldPrice: number; newPrice: number; changePercent: number }) => {
      const arrow = item.newPrice < item.oldPrice ? "▼" : item.newPrice > item.oldPrice ? "▲" : "";
      const arrowHtml = arrow ? `  ${arrow} ${pct(item.changePercent)}` : "";
      return `<div style="border-bottom:1px solid #eee;padding:8px 0"><p style="margin:0;font-weight:600;color:#333">${esc(item.title)}</p><p style="margin:4px 0 0;color:#666;font-size:14px">${fmt(item.oldPrice)} → ${fmt(item.newPrice)}${arrowHtml}</p></div>`;
    };

    // Body content
    let bodyHtml = "";
    if (args.variant === "threshold") {
      if (args.belowHits.length > 0) {
        bodyHtml += `<p style="margin:0 0 8px;color:#10b981;font-weight:600">⚡ Below your ${fmt(args.belowThreshold ?? 0)} threshold</p>`;
        bodyHtml += args.belowHits.map(row).join("");
      }
      if (args.aboveHits.length > 0) {
        bodyHtml += `<p style="margin:16px 0 8px;color:#f59e0b;font-weight:600">⚡ Above your ${fmt(args.aboveThreshold ?? 0)} threshold</p>`;
        bodyHtml += args.aboveHits.map(row).join("");
      }
    } else if (isMultiple) {
      const drops = args.priceChanges.filter((c) => c.change < 0);
      const increases = args.priceChanges.filter((c) => c.change > 0);
      if (drops.length > 0) {
        bodyHtml += `<p style="margin:0 0 8px;color:#10b981;font-weight:600">Price Drops</p>`;
        bodyHtml += drops.map(row).join("");
      }
      if (increases.length > 0) {
        bodyHtml += `<p style="margin:${drops.length > 0 ? "16" : "0"}px 0 8px;color:#f59e0b;font-weight:600">Price Increases</p>`;
        bodyHtml += increases.map(row).join("");
      }
    } else {
      bodyHtml += args.priceChanges.map(row).join("");
    }

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
      <div style="background:${headerColor};padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600">${headerTitle}</h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:14px">${esc(args.monitorName)}</p>
      </div>
      <div style="padding:32px">
        ${bodyHtml}
        <div style="margin-top:24px">
          <a href="${safeHref(args.url)}" style="display:inline-block;background:${headerColor};color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px;margin-right:8px">View on site</a>
          <a href="${APP_URL}/dashboard/monitors/${args.monitorId}" style="display:inline-block;background:#f4f4f5;color:#333;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px">View in PageAlert</a>
        </div>
      </div>
      <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #eee">
        <p style="margin:0;color:#999;font-size:12px">
          Tracking ${args.trackedItemCount} items · <a href="${safeHref(manageUrl)}" style="color:#999">Manage price alerts</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;

    const rowText = (item: { title: string; oldPrice: number; newPrice: number; changePercent: number }) =>
      `• ${item.title}: ${fmt(item.oldPrice)} → ${fmt(item.newPrice)} (${item.newPrice < item.oldPrice ? "-" : "+"}${pct(item.changePercent)})`;
    let textBody = "";
    if (args.variant === "threshold") {
      if (args.belowHits.length > 0) textBody += `Below ${fmt(args.belowThreshold ?? 0)} threshold:\n${args.belowHits.map(rowText).join("\n")}\n\n`;
      if (args.aboveHits.length > 0) textBody += `Above ${fmt(args.aboveThreshold ?? 0)} threshold:\n${args.aboveHits.map(rowText).join("\n")}\n\n`;
    } else {
      textBody += args.priceChanges.map(rowText).join("\n") + "\n\n";
    }
    const text = `${headerTitle} — ${args.monitorName}\n\n${textBody}View on site: ${args.url}\nView in PageAlert: ${APP_URL}/dashboard/monitors/${args.monitorId}\nManage price alerts: ${manageUrl}`;

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ from: FROM_EMAIL, to: [args.to], subject, html, text }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT),
      });
      if (!res.ok) {
        console.error("[email] Resend API error:", res.status, "monitor:", args.monitorId);
        return;
      }
      console.log(`[email] Price alert sent, monitor: ${args.monitorId}, variant: ${args.variant}`);
    } catch (e) {
      console.error("[email] Failed to send price alert, monitor:", args.monitorId, e instanceof Error ? e.message : "");
    }
  },
});

/**
 * Day 0 onboarding (welcome) email.
 *
 * The body hands the user one worked example (refurbished Mac Mini M4
 * Pro on Apple Canada's refurb store) plus a "Try this monitor" deep-link
 * that opens the create-monitor sheet pre-populated. The deep-link
 * handler lives in app/(dashboard)/dashboard/page.tsx — see PROWL-038
 * Phase 4e.
 *
 * The processor that triggers this is internally gated by
 * ONBOARDING_EMAILS_ENABLED, so this won't auto-send until James
 * approves the template.
 */
export const sendOnboardingDay0 = internalAction({
  args: { to: v.string(), userId: v.string() },
  handler: async (_ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[onboarding] RESEND_API_KEY not configured, skipping");
      return;
    }

    // The "try this monitor" deep-link. Apple's refurbished Mac Mini
    // page has volatile stock — items appear and sell out fast, which
    // makes it a perfect, relatable monitoring use case. Currently
    // only ~1 base model is listed; M4 Pro models come and go in waves.
    const tryUrl = "https://www.apple.com/ca/shop/refurbished/mac/mac-mini";
    const tryPrompt = "Mac Mini M4 Pro under $1,500";
    const tryHref = `${APP_URL}/dashboard?try=${encodeURIComponent(tryUrl)}&prompt=${encodeURIComponent(tryPrompt)}`;
    const dashboardHref = `${APP_URL}/dashboard`;

    const subject = "Welcome to PageAlert — let's set up your first monitor";

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0a0a0b">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
      <div style="background:#3b82f6;padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600">Welcome to PageAlert</h1>
      </div>
      <div style="padding:32px;line-height:1.55">
        <p style="margin:0 0 16px;color:#0a0a0b;font-size:16px">
          You're in. Thanks for signing up.
        </p>
        <p style="margin:0 0 24px;color:#444;font-size:15px">
          PageAlert watches any web page using AI &mdash; just paste a URL and describe what you're looking for in plain English. We'll check the page on a schedule and notify you the moment your conditions are met. No CSS selectors, no scraping code, no maintenance.
        </p>

        <div style="background:#f4f6fb;border-left:3px solid #3b82f6;padding:16px 20px;border-radius:6px;margin:0 0 28px">
          <p style="margin:0 0 8px;color:#0a0a0b;font-size:14px;font-weight:600">Here's something people are already doing</p>
          <p style="margin:0;color:#444;font-size:14px">
            Apple sells refurbished Macs at a solid discount &mdash; verified, with warranty, same as new. The catch is stock comes and goes fast, especially for popular configs like the Mac Mini M4 Pro. A few of our users have PageAlert watching the refurb page so they get a heads up the moment one appears at their price.
          </p>
        </div>

        <p style="margin:0 0 16px;color:#0a0a0b;font-size:15px;font-weight:600">
          Try this exact monitor &mdash; one click:
        </p>
        <a href="${safeHref(tryHref)}" style="display:inline-block;background:#3b82f6;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
          Try this monitor &rarr;
        </a>
        <p style="margin:12px 0 0;color:#888;font-size:12px">
          Opens the create-monitor screen with the URL and prompt pre-filled. Edit anything before you scan.
        </p>

        <div style="margin-top:32px;padding-top:24px;border-top:1px solid #eee">
          <p style="margin:0 0 8px;color:#444;font-size:14px">Want to start from scratch instead?</p>
          <a href="${safeHref(dashboardHref)}" style="color:#3b82f6;text-decoration:none;font-weight:500;font-size:14px">
            Open your dashboard &rarr;
          </a>
        </div>
      </div>
      <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #eee">
        <p style="margin:0;color:#999;font-size:12px">
          PageAlert &mdash; AI-powered website monitoring. <a href="${APP_URL}" style="color:#999">pagealert.io</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;

    const text = `Welcome to PageAlert!

You're in. Thanks for signing up.

PageAlert watches any web page using AI — just paste a URL and describe what you're looking for in plain English. We'll check the page on a schedule and notify you the moment your conditions are met.

Here's something people are already doing:
Apple sells refurbished Macs at a solid discount — verified, with warranty, same as new. The catch is stock comes and goes fast, especially for popular configs like the Mac Mini M4 Pro. A few of our users have PageAlert watching the refurb page so they get a heads up the moment one appears at their price.

Try this exact monitor in one click:
${tryHref}

Or start from scratch:
${dashboardHref}

— PageAlert
${APP_URL}`;

    // Unlike the notification senders (sendMatchAlert etc.) which swallow
    // errors, this function intentionally rethrows so the caller
    // (processDueEmails) can mark the row as "failed" with the error
    // message. Network errors, timeouts, and non-OK responses all
    // propagate as thrown errors for consistent failure handling.
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: HELLO_FROM_EMAIL,
          to: [args.to],
          subject,
          html,
          text,
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("[onboarding] day0 email failed:", res.status, body, "user:", args.userId);
        throw new Error(`Day0 email failed: ${res.status}`);
      }
      console.log("[onboarding] day0 email sent, user:", args.userId);
    } catch (e) {
      console.error("[onboarding] day0 email network error:", e, "user:", args.userId);
      throw e;
    }
  },
});
