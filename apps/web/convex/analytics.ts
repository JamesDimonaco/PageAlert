/**
 * Server-side PostHog capture, for events no browser sees, such as an alert
 * sent from the scheduler. Failures are logged and swallowed: analytics must
 * never break the alert it is counting.
 */
export async function captureEvent(
  distinctId: string,
  event: string,
  properties: Record<string, string>
): Promise<void> {
  const apiKey = process.env.POSTHOG_KEY;
  if (!apiKey) return;
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
}
