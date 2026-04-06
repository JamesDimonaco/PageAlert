import posthog from "posthog-js";

export const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
export const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

let initialized = false;
let pendingPageView: string | null = null;

export function initPostHog() {
  if (typeof window === "undefined") return;
  if (!POSTHOG_KEY) return;
  if (initialized) return;

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
  initialized = true;

  // Fire any pageview that was queued before init
  if (pendingPageView) {
    posthog.capture("$pageview", { $current_url: pendingPageView });
    pendingPageView = null;
  }

  // Lazily start session recording after main thread is idle
  if ("requestIdleCallback" in window) {
    requestIdleCallback(() => posthog.startSessionRecording());
  } else {
    setTimeout(() => posthog.startSessionRecording(), 3000);
  }
}

export function getPostHog() {
  return initialized ? posthog : null;
}

// ---- Core helpers ----

export function identifyUser(userId: string, properties?: Record<string, unknown>) {
  if (!initialized) return;
  posthog.identify(userId, properties);
}

export function setUserProperties(properties: Record<string, unknown>) {
  if (!initialized) return;
  posthog.people.set(properties);
}

export function resetUser() {
  if (!initialized) return;
  posthog.reset();
}

export function trackEvent(event: string, properties?: Record<string, unknown>) {
  if (!initialized) return;
  posthog.capture(event, properties);
}

export function trackPageView(url: string) {
  if (!initialized) {
    pendingPageView = url;
    return;
  }
  posthog.capture("$pageview", { $current_url: url });
}

// ---- Feature flags ----

export function isFeatureEnabled(flag: string): boolean {
  if (!initialized) return false;
  return posthog.isFeatureEnabled(flag) ?? false;
}

export function getFeatureFlag(flag: string): string | boolean | undefined {
  if (!initialized) return undefined;
  return posthog.getFeatureFlag(flag);
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
  if (!initialized) return;
  const err = error instanceof Error ? error : new Error(String(error));
  posthog.captureException(err, context);
}

// ---- Helpers ----

function safeDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return "unknown"; }
}
