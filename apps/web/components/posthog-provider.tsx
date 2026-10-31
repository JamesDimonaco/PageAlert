"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { initPostHog, onPostHogReady, trackPageView, trackSignUp, SIGNED_UP_PARAM } from "@/lib/posthog";

// Strict Mode runs effects twice in dev, and both runs see the marker.
let signUpTracked = false;

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Init PostHog after main thread is idle so it doesn't block LCP/TBT
  useEffect(() => {
    if ("requestIdleCallback" in window) {
      requestIdleCallback(() => initPostHog());
    } else {
      setTimeout(() => initPostHog(), 2000);
    }
  }, []);

  // Track page views on route changes. Not while the sign-up marker is still
  // in the URL: stripping it changes searchParams and records the clean view.
  useEffect(() => {
    if (pathname && !searchParams?.has(SIGNED_UP_PARAM)) {
      const url = searchParams?.toString()
        ? `${pathname}?${searchParams.toString()}`
        : pathname;
      trackPageView(url);
    }
  }, [pathname, searchParams]);

  // OAuth sign-ups land here with a marker from the login page. Strip it so a
  // reload or shared link can't fire sign_up again.
  useEffect(() => {
    const method = searchParams?.get(SIGNED_UP_PARAM);
    if (method !== "google" && method !== "github") return;
    if (signUpTracked) return;
    signUpTracked = true;
    const url = new URL(window.location.href);
    url.searchParams.delete(SIGNED_UP_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    // trackEvent drops events until posthog-js has loaded, so wait for it.
    onPostHogReady(() => trackSignUp({ method }));
  }, [searchParams]);

  return <>{children}</>;
}
