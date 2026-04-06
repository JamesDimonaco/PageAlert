"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { initPostHog, trackPageView } from "@/lib/posthog";

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

  // Track page views on route changes
  useEffect(() => {
    if (pathname) {
      const url = searchParams?.toString()
        ? `${pathname}?${searchParams.toString()}`
        : pathname;
      trackPageView(url);
    }
  }, [pathname, searchParams]);

  return <>{children}</>;
}
