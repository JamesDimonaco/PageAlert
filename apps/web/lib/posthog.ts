import type { PostHog } from "posthog-js";

export const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
export const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

// posthog-js is ~100KB gzipped. Importing it lazily keeps it out of the
// initial bundle; `ph` stays null until the chunk lands, and every helper
// below no-ops (or queues) until then.
let ph: PostHog | null = null;
let initStarted = false;
let pendingPageViews: string[] = [];
let pendingIdentify: { userId: string; properties?: Record<string, unknown> } | null = null;
let pendingUserProperties: Record<string, unknown> | null = null;
let readyCallbacks: Array<(posthog: PostHog) => void> = [];

export function initPostHog() {
  if (typeof window === "undefined") return;
  if (!POSTHOG_KEY) return;
  if (initStarted) return;
  initStarted = true;

  void import("posthog-js").then(({ default: posthog }) => {
    posthog.init(POSTHOG_KEY, {
      api_host: "/ingest",
      ui_host: POSTHOG_HOST,
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: true,
      capture_exceptions: true,
      persistence: "localStorage+cookie",
      person_profiles: "identified_only",
      disable_session_recording: true,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "[data-ph-mask]",
      },
    });
    ph = posthog;

    // Identify before flushing, so queued pageviews and properties attach to
    // the right person.
    if (pendingIdentify) {
      posthog.identify(pendingIdentify.userId, pendingIdentify.properties);
      pendingIdentify = null;
    }

    if (pendingUserProperties) {
      posthog.people.set(pendingUserProperties);
      pendingUserProperties = null;
    }

    for (const url of pendingPageViews) {
      posthog.capture("$pageview", { $current_url: url });
    }
    pendingPageViews = [];

    for (const cb of readyCallbacks) cb(posthog);
    readyCallbacks = [];

    // init reads the stored opt-out back, so capture() is already dropping
    // events by now; recording is gated here too so that stays visibly true.
    if (posthog.has_opted_out_capturing()) return;

    // Lazily start session recording after main thread is idle
    if ("requestIdleCallback" in window) {
      requestIdleCallback(() => posthog.startSessionRecording());
    } else {
      setTimeout(() => posthog.startSessionRecording(), 3000);
    }
  }).catch(() => {
    // Chunk failed to load (stale tab across a deploy, flaky network).
    // Allow a later initPostHog() to retry rather than killing analytics
    // for the whole session.
    initStarted = false;
  });
}

export function getPostHog() {
  return ph;
}

// ---- Core helpers ----

export function identifyUser(userId: string, properties?: Record<string, unknown>) {
  if (!ph) {
    pendingIdentify = { userId, properties };
    return;
  }
  ph.identify(userId, properties);
}

export function setUserProperties(properties: Record<string, unknown>) {
  if (!ph) {
    pendingUserProperties = { ...pendingUserProperties, ...properties };
    return;
  }
  ph.people.set(properties);
}

export function resetUser() {
  pendingIdentify = null;
  pendingUserProperties = null;
  if (!ph) return;
  // reset() wipes the stored consent along with the identity, which would
  // opt the next sign-in back in. The opt-out belongs to the browser.
  const optedOut = ph.has_opted_out_capturing();
  ph.reset();
  if (optedOut) ph.opt_out_capturing();
}

// ---- Analytics opt-out ----
// PostHog stores consent itself, per browser, and reads it back on init.
// Nothing is synced to the account: the Settings copy says "this browser".

/** Runs once posthog-js has loaded; triggers the load if nothing has yet. */
export function onPostHogReady(cb: (posthog: PostHog) => void): () => void {
  if (ph) {
    cb(ph);
    return () => {};
  }
  readyCallbacks.push(cb);
  initPostHog();
  return () => {
    readyCallbacks = readyCallbacks.filter((c) => c !== cb);
  };
}

export function setAnalyticsOptOut(optOut: boolean) {
  if (!ph) return;
  if (optOut) {
    ph.opt_out_capturing();
    ph.stopSessionRecording();
  } else {
    ph.opt_in_capturing();
    ph.startSessionRecording();
  }
}

export function trackEvent(event: string, properties?: Record<string, unknown>) {
  if (!ph) return;
  ph.capture(event, properties);
}

export function trackPageView(url: string) {
  if (!ph) {
    pendingPageViews.push(url);
    return;
  }
  ph.capture("$pageview", { $current_url: url });
}

// ---- Feature flags ----

export function isFeatureEnabled(flag: string): boolean {
  if (!ph) return false;
  return ph.isFeatureEnabled(flag) ?? false;
}

export function getFeatureFlag(flag: string): string | boolean | undefined {
  if (!ph) return undefined;
  return ph.getFeatureFlag(flag);
}

// ---- Revenue / Billing events ----

export function trackCheckoutStarted(props: { plan: string; price: number }) {
  trackEvent("checkout_started", {
    plan: props.plan,
    price_usd: props.price,
  });
}

export function trackCheckoutCompleted(props: { plan: string; price: number }) {
  trackEvent("checkout_completed", {
    plan: props.plan,
    price_usd: props.price,
    $set: { tier: props.plan }, // Update user property
  });
}

export function trackUpgradePromptShown(props: { reason: string; currentTier: string }) {
  trackEvent("upgrade_prompt_shown", {
    reason: props.reason,
    current_tier: props.currentTier,
  });
}

export function trackUpgradePromptClicked(props: { plan: string; currentTier: string }) {
  trackEvent("upgrade_prompt_clicked", {
    target_plan: props.plan,
    current_tier: props.currentTier,
  });
}

export function trackSubscriptionChanged(props: { from: string; to: string }) {
  trackEvent("subscription_changed", {
    from_tier: props.from,
    to_tier: props.to,
  });
}

// ---- Monitor lifecycle ----

export function trackMonitorCreated(props: { url: string; prompt: string; checkInterval: string }) {
  trackEvent("monitor_created", {
    url_domain: safeDomain(props.url),
    prompt_length: props.prompt.length,
    check_interval: props.checkInterval,
  });
}

export function trackMonitorDraftRestored() {
  trackEvent("monitor_draft_restored");
}

export function trackMonitorDraftCleared() {
  trackEvent("monitor_draft_cleared");
}

export function trackMonitorDeleted() {
  trackEvent("monitor_deleted");
}

export function trackMonitorPaused() {
  trackEvent("monitor_paused");
}

export function trackMonitorResumed() {
  trackEvent("monitor_resumed");
}

// ---- Scan events ----

export function trackScanStarted(props: { url: string }) {
  trackEvent("scan_started", { url_domain: safeDomain(props.url) });
}

export function trackScanCompleted(props: {
  url: string;
  itemCount: number;
  matchCount: number;
  durationMs: number;
  confidence?: number;
}) {
  trackEvent("scan_completed", {
    url_domain: safeDomain(props.url),
    item_count: props.itemCount,
    match_count: props.matchCount,
    duration_ms: props.durationMs,
    ai_confidence: props.confidence,
  });
}

export function trackScanFailed(props: { url: string; error: string; durationMs: number }) {
  trackEvent("scan_failed", {
    url_domain: safeDomain(props.url),
    error: props.error.slice(0, 200),
    duration_ms: props.durationMs,
  });
}

// ---- Match events ----

export function trackMatchFound(props: { monitorId: string; matchCount: number }) {
  trackEvent("match_found", {
    monitor_id: props.monitorId,
    match_count: props.matchCount,
  });
}

// ---- User interaction events ----

export function trackFilterEdited() {
  trackEvent("filter_edited");
}

export function trackFilterSaved() {
  trackEvent("filter_saved");
}

export function trackItemDismissed() {
  trackEvent("item_dismissed");
}

export function trackItemRestored() {
  trackEvent("item_restored");
}

// ---- Notification events ----

export function trackTestEmailSent() {
  trackEvent("test_email_sent");
}

export function trackNotificationChannelToggled(props: { channel: string; enabled: boolean }) {
  trackEvent("notification_channel_toggled", {
    channel: props.channel,
    enabled: props.enabled,
  });
}

// ---- Auth events ----

export function trackSignUp(props: { method: string }) {
  trackEvent("sign_up", { method: props.method });
}

export function trackSignIn(props: { method: string }) {
  trackEvent("sign_in", { method: props.method });
}

export function trackSignOut() {
  trackEvent("sign_out");
}

// ---- Error tracking ----

export function captureException(error: unknown, context?: Record<string, unknown>) {
  if (!ph) return;
  const err = error instanceof Error ? error : new Error(String(error));
  ph.captureException(err, context);
}

// ---- Helpers ----

function safeDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return "unknown"; }
}
