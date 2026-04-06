"use client";

import { authClient } from "@/lib/auth-client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState, useEffect, useCallback, useRef } from "react";
import { setUserProperties } from "@/lib/posthog";

export type Tier = "free" | "pro" | "max";

export const TIER_LIMITS: Record<Tier, {
  maxMonitors: number;
  minInterval: string;
  channels: string[];
  description: string;
  allowedIntervals: string[];
}> = {
  free: {
    maxMonitors: 3,
    minInterval: "6h",
    channels: ["email"],
    description: "3 monitors, 6 hour checks, email only",
    allowedIntervals: ["6h", "24h"],
  },
  pro: {
    maxMonitors: 25,
    minInterval: "15m",
    channels: ["email", "telegram", "discord"],
    description: "25 monitors, 15 min checks, all channels",
    allowedIntervals: ["15m", "30m", "1h", "6h", "24h"],
  },
  max: {
    maxMonitors: 9999,
    minInterval: "5m",
    channels: ["email", "telegram", "discord", "webhook"],
    description: "Unlimited monitors, 5 min checks, API access",
    allowedIntervals: ["5m", "15m", "30m", "1h", "6h", "24h"],
  },
};

function detectTier(subscriptions: Array<Record<string, unknown>>): Tier {
  let best: Tier = "free";
  for (const sub of subscriptions) {
    const slug = String(sub.slug ?? sub.productSlug ?? "").toLowerCase();
    const name = String(sub.productName ?? sub.name ?? "").toLowerCase();
    if (slug === "max" || name.includes("max")) return "max"; // can't go higher
    if (slug === "pro" || name.includes("pro")) best = "pro";
  }
  return best;
}

interface TierInfo {
  tier: Tier;
  isLoading: boolean;
  maxMonitors: number;
  minInterval: string;
  channels: string[];
  description: string;
  allowedIntervals: string[];
  isCancelled: boolean;
  periodEnd: number | null;
  daysRemaining: number | null;
  refetch: () => void;
}

// Pick the higher-privilege tier between two sources
const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, max: 2 };
function higherTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export function useTier(): TierInfo {
  // Primary: Convex DB (reactive, updated by webhooks)
  const convexTier = useQuery(api.tiers.get);

  const [polarTier, setPolarTier] = useState<Tier | null>(null);
  const [polarLoading, setPolarLoading] = useState(false);

  // Use the higher of Convex or Polar tier (handles stale Convex before webhook fires)
  const convexValue = convexTier?.tier ?? null;
  const tier: Tier = convexValue && polarTier
    ? higherTier(convexValue, polarTier)
    : convexValue ?? polarTier ?? "free";

  // Loading if either source hasn't resolved yet
  const isLoading = convexTier === undefined || polarLoading;

  // Fetch tier from Polar as a fallback/fresh read
  const fetchAndSync = useCallback(async () => {
    setPolarLoading(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = authClient as any;
      // Guard: customer.state() may not exist on all versions of @polar-sh/better-auth
      if (typeof client.customer?.state !== "function") {
        setPolarTier(null);
        return;
      }
      const state = await client.customer.state();

      // Server returned an error (e.g. Polar not configured in dev)
      if (state?.error || !state?.data) {
        setPolarTier(null);
        return;
      }

      const subs = state.data.activeSubscriptions ?? state.data.subscriptions ?? [];
      if (Array.isArray(subs) && subs.length > 0) {
        setPolarTier(detectTier(subs));
      } else {
        setPolarTier("free");
      }
    } catch {
      // Polar fallback is non-critical — Convex tier is the primary source
    } finally {
      setPolarLoading(false);
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchAndSync();
  }, [fetchAndSync]);

  // Refetch on window focus (user returns from checkout)
  useEffect(() => {
    function onFocus() { fetchAndSync(); }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchAndSync]);

  // Refetch on ?upgraded=true
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.search.includes("upgraded=true")) {
      const timer = setTimeout(() => fetchAndSync(), 1500);
      return () => clearTimeout(timer);
    }
  }, [fetchAndSync]);

  // Sync tier to PostHog user properties whenever it changes
  const prevTierRef = useRef<Tier | null>(null);
  useEffect(() => {
    if (!isLoading && tier !== prevTierRef.current) {
      prevTierRef.current = tier;
      setUserProperties({ tier, plan: tier });
    }
  }, [tier, isLoading]);

  const isCancelled = convexTier?.isCancelled ?? false;
  const periodEnd = convexTier?.periodEnd ?? null;

  // Compute daysRemaining client-side only to avoid SSR hydration mismatch
  const [daysRemaining, setDaysRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (periodEnd) {
      setDaysRemaining(Math.max(0, Math.ceil((periodEnd - Date.now()) / (1000 * 60 * 60 * 24))));
    } else {
      setDaysRemaining(null);
    }
  }, [periodEnd]);

  return {
    tier,
    isLoading,
    isCancelled,
    periodEnd,
    daysRemaining,
    refetch: fetchAndSync,
    ...TIER_LIMITS[tier],
  };
}
