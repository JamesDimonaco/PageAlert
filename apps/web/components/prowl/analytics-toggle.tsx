"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { POSTHOG_KEY, onPostHogReady, setAnalyticsOptOut } from "@/lib/posthog";

/**
 * The analytics opt-out, on both the privacy page and Settings.
 *
 * It has to be reachable without an account: capture and session replay start
 * on the landing page and the anonymous /try flow, so the people most likely
 * to want it off are the ones who cannot reach the dashboard. The privacy
 * page is where the policy explains the thing, and it needs no login.
 *
 * Consent lives in PostHog's own storage, which is per browser. Nothing is
 * written to the account, and the copy says so rather than implying a setting
 * that follows the user around.
 */
export function AnalyticsToggle() {
  const [optedOut, setOptedOut] = useState<boolean | null>(null);

  useEffect(() => onPostHogReady((p) => setOptedOut(p.has_opted_out_capturing())), []);

  if (!POSTHOG_KEY) return null;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">
        We use PostHog to record page views, clicks and errors, and to replay sessions: the pages
        you visit and what you click, with anything you type masked. Turning this off stops both,
        in this browser only — other browsers and devices keep their own setting.
      </p>
      <Button
        variant={optedOut ? "default" : "outline"}
        size="sm"
        disabled={optedOut === null}
        className="shrink-0"
        onClick={() => {
          const next = !optedOut;
          setAnalyticsOptOut(next);
          setOptedOut(next);
          toast.success(next ? "Analytics off in this browser" : "Analytics on in this browser");
        }}
      >
        {/* The verb, not the state: on a consent control "Enabled" reads as
            the thing you are about to get, not the thing you already have. */}
        {optedOut === null ? "Loading" : optedOut ? "Turn analytics on" : "Turn analytics off"}
      </Button>
    </div>
  );
}
