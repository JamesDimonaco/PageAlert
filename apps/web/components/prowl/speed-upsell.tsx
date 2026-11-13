"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Zap } from "lucide-react";
import type { Tier } from "@/hooks/use-tier";
import { PLANS } from "@/lib/plans";
import { trackUpgradePrompt } from "@/lib/posthog";

const SPRINT_PRICE = PLANS.find((p) => p.slug === "sprint")?.price;

/**
 * Offers the Sprint pass on speed, right after a free user's first scan
 * works. People watch restocks and slots, where an hourly check is often too
 * late. Never blocks anything.
 */
export function SpeedUpsell({ tier, tierResolved, proxyFloored }: {
  tier: Tier;
  /** useTier's `resolved`, so a stale tier never shows the offer or fires its event */
  tierResolved: boolean;
  /** A proxy-only site checks every 6 hours on any plan, so faster checks would be a false promise. */
  proxyFloored: boolean;
}) {
  const visible = tierResolved && tier === "free" && !proxyFloored && SPRINT_PRICE !== undefined;

  const trackedRef = useRef(false);
  useEffect(() => {
    if (!visible || trackedRef.current) return;
    trackedRef.current = true;
    trackUpgradePrompt("shown", { placement: "first_scan", currentTier: tier, targetPlan: "sprint" });
  }, [visible, tier]);

  if (!visible) return null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
      <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary/70" />
      <p className="flex-1 text-muted-foreground">
        Your monitor works. Free checks it every hour, and restocks can sell out in minutes. A ${SPRINT_PRICE} Sprint
        pass checks every 15 minutes for 30 days, with no subscription.{" "}
        <Link
          href="/dashboard/settings?tab=billing&from=first_scan"
          onClick={() => trackUpgradePrompt("clicked", { placement: "first_scan", currentTier: tier, targetPlan: "sprint" })}
          className="font-medium text-primary hover:underline"
        >
          Get a Sprint pass
        </Link>
      </p>
    </div>
  );
}
