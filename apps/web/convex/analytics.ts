import { v } from "convex/values";
import { internalAction } from "./_generated/server";

let warnedNoKey = false;

/**
 * Server-side PostHog capture, for events no browser sees, such as an alert
 * sent from the scheduler. Scheduled rather than awaited by callers, and
 * failures are logged and swallowed: analytics must never slow or break the
 * alert it is counting.
 */
export const capture = internalAction({
  args: {
    distinctId: v.string(),
    event: v.string(),
    properties: v.record(v.string(), v.string()),
  },
  handler: async (_ctx, { distinctId, event, properties }) => {
    const apiKey = process.env.POSTHOG_KEY;
    if (!apiKey) {
      if (!warnedNoKey) console.warn("[analytics] POSTHOG_KEY is not set — server events are dropped");
      warnedNoKey = true;
      return;
    }
    const host = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";
    try {
      const res = await fetch(`${host}/i/v0/e/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, event, distinct_id: distinctId, properties }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) console.warn(`[analytics] ${event} capture failed: ${res.status}`);
    } catch (e) {
      console.warn(`[analytics] ${event} capture failed:`, e instanceof Error ? e.message : e);
    }
  },
});
