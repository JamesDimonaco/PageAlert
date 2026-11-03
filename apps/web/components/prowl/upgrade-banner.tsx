"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TIER_LIMITS, type Tier } from "@/hooks/use-tier";
import { PLANS } from "@/lib/plans";
import { trackUpgradeBanner } from "@/lib/posthog";

const DISMISSED_KEY = "pagealert_upgrade_banner_dismissed_at";
const HIDE_FOR_MS = 7 * 24 * 60 * 60 * 1000;

const noSubscribe = () => () => {};
function readDismissed() {
  return Date.now() - Number(localStorage.getItem(DISMISSED_KEY)) < HIDE_FOR_MS;
}

const NEXT_TIER: Record<Tier, Tier | null> = { free: "sprint", sprint: "pro", pro: "max", max: null };

/** Shown when every monitor slot on the plan is used. Never blocks anything. */
export function UpgradeBanner({ tier, tierLoading, monitorCount }: {
  tier: Tier;
  tierLoading: boolean;
  monitorCount: number;
}) {
  // useTier reports loading again on every window focus; only the first load
  // matters here, otherwise the banner would flicker each time.
  const [tierReady, setTierReady] = useState(false);
  if (!tierLoading && !tierReady) setTierReady(true);

  const dismissedRecently = useSyncExternalStore(noSubscribe, readDismissed, () => true);
  const [dismissedNow, setDismissedNow] = useState(false);
  const dismissed = dismissedRecently || dismissedNow;

  const next = NEXT_TIER[tier];
  const visible = tierReady && !dismissed && next !== null && monitorCount >= TIER_LIMITS[tier].maxMonitors;

  const trackedRef = useRef(false);
  useEffect(() => {
    if (!visible) {
      trackedRef.current = false;
      return;
    }
    if (trackedRef.current || !next) return;
    trackedRef.current = true;
    trackUpgradeBanner("shown", { currentTier: tier, nextTier: next });
  }, [visible, tier, next]);

  if (!visible || !next) return null;

  const nextName = PLANS.find((p) => p.slug === next)?.name ?? next;
  const nextLimit = next === "max" ? "unlimited" : TIER_LIMITS[next].maxMonitors;

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    setDismissedNow(true);
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-muted/30 px-4 py-2.5 text-sm">
      <Sparkles className="h-4 w-4 shrink-0 text-primary/70" />
      <p className="flex-1 text-muted-foreground">
        You&apos;re using all {TIER_LIMITS[tier].maxMonitors} monitors on your plan. {nextName} gives you {nextLimit}.{" "}
        <Link
          href="/dashboard/settings?tab=billing"
          onClick={() => trackUpgradeBanner("clicked", { currentTier: tier, nextTier: next })}
          className="font-medium text-primary hover:underline"
        >
          See plans
        </Link>
      </p>
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={dismiss} aria-label="Dismiss">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
