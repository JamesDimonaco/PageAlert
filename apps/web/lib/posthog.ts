import posthog from "posthog-js";

export const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
export const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

let initialized = false;

export function initPostHog() {
  if (typeof window === "undefined") return;
  if (!POSTHOG_KEY) return;

  posthog.init(POSTHOG_KEY, {
    api_host: "/ingest", // Reverse proxy to avoid ad blockers
    ui_host: POSTHOG_HOST,
    capture_pageview: false, // We capture manually for SPA route changes
    capture_pageleave: true,
    autocapture: true,
    capture_exceptions: true, // Error tracking — auto-captures unhandled exceptions
    persistence: "localStorage+cookie",
    person_profiles: "identified_only",
    session_recording: {
      maskAllInputs: true, // PII protection
      maskTextSelector: "[data-ph-mask]", // Custom masking
    },
  });
  initialized = true;
}

// ---- Typed event helpers ----

export function identifyUser(userId: string, properties?: Record<string, unknown>) {
  if (!initialized) return;
  posthog.identify(userId, properties);
}

export function resetUser() {
  if (!initialized) return;
  posthog.reset();
}

export function trackEvent(event: string, properties?: Record<string, unknown>) {
  if (!initialized) return;
  posthog.capture(event, properties);
}

// ---- Specific events ----

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

export function trackScanStarted(props: { url: string }) {
  trackEvent("scan_started", { url_domain: safeDomain(props.url) });
}

export function trackScanCompleted(props: { url: string; itemCount: number; matchCount: number; durationMs: number; confidence?: number }) {
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

export function trackMatchFound(props: { monitorId: string; matchCount: number }) {
  trackEvent("match_found", {
    monitor_id: props.monitorId,
    match_count: props.matchCount,
  });
}

export function trackFilterEdited() {
  trackEvent("filter_edited");
}

export function trackItemDismissed() {
  trackEvent("item_dismissed");
}

export function trackPageView(url: string) {
  posthog.capture("$pageview", { $current_url: url });
}

function safeDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return "unknown"; }
}
