"use client";

import { authClient } from "@/lib/auth-client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState, useEffect, useCallback, useRef } from "react";
import { setUserProperties } from "@/lib/posthog";

export type Tier = "free" | "pro" | "business";

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
  business: {
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
    if (slug === "business" || name.includes("business")) return "business"; // can't go higher
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
  refetch: () => void;
}

// Pick the higher-privilege tier between two sources
const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, business: 2 };
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
      const state = await client.customer?.state?.();

      if (state?.data) {
        const subs = state.data.activeSubscriptions ?? state.data.subscriptions ?? [];
        if (Array.isArray(subs) && subs.length > 0) {
          setPolarTier(detectTier(subs));
        } else {
          // No active subscriptions — user is free
          setPolarTier("free");
        }
      }
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.error("useTier: failed to fetch from Polar", err);
      }
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

  return {
    tier,
    isLoading,
    refetch: fetchAndSync,
    ...TIER_LIMITS[tier],
  };
}
