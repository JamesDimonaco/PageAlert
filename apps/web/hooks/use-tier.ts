"use client";

import { authClient } from "@/lib/auth-client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState, useEffect, useCallback, useRef } from "react";
import { setUserProperties } from "@/lib/posthog";

export type Tier = "free" | "sprint" | "pro" | "max";

export const TIER_LIMITS: Record<Tier, {
  maxMonitors: number;
  minInterval: string;
  description: string;
  allowedIntervals: string[];
}> = {
  free: {
    maxMonitors: 3,
    minInterval: "1h",
    description: "3 monitors, hourly checks",
    allowedIntervals: ["1h", "6h", "24h"],
  },
  sprint: {
    maxMonitors: 10,
    minInterval: "30m",
    description: "10 monitors, 30 min checks, all channels",
    allowedIntervals: ["30m", "1h", "6h", "24h"],
  },
  pro: {
    maxMonitors: 25,
    minInterval: "15m",
    description: "25 monitors, 15 min checks, all channels",
    allowedIntervals: ["15m", "30m", "1h", "6h", "24h"],
  },
  max: {
    maxMonitors: 9999,
    minInterval: "5m",
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
  description: string;
  allowedIntervals: string[];
  isCancelled: boolean;
  periodEnd: number | null;
  daysRemaining: number | null;
  /** Set while time-boxed access is live — an admin trial or a bought pass */
  grantUntil: number | null;
  /** Which of those it is; null when there is no live grant */
  grantSource: "admin" | "pass" | null;
  refetch: () => void;
}

// useTier mounts more than once per page (navbar + page body), and each mount
// used to fire its own Polar round trip on load. Share the in-flight read so
// they make one request between them.
let inflightPolarTier: Promise<Tier | null | undefined> | null = null;

/** Resolves to the Polar tier, null if there is none, or undefined if the call failed. */
function fetchPolarTier(force = false): Promise<Tier | null | undefined> {
  if (inflightPolarTier && !force) return inflightPolarTier;
  const p = (async (): Promise<Tier | null | undefined> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = authClient as any;
      // Guard: customer.state() may not exist on all versions of @polar-sh/better-auth
      if (typeof client.customer?.state !== "function") return null;
      const state = await client.customer.state();

      // Server returned an error (e.g. Polar not configured in dev)
      if (state?.error || !state?.data) return null;

      const subs = state.data.activeSubscriptions ?? state.data.subscriptions ?? [];
      if (Array.isArray(subs) && subs.length > 0) return detectTier(subs);
      return "free";
    } catch {
      // Polar fallback is non-critical — Convex tier is the primary source
      return undefined;
    }
  })();
  inflightPolarTier = p;
  void p.finally(() => {
    if (inflightPolarTier === p) inflightPolarTier = null;
  });
  return p;
}

// Pick the higher-privilege tier between two sources
const TIER_RANK: Record<Tier, number> = { free: 0, sprint: 1, pro: 2, max: 3 };
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
  const fetchAndSync = useCallback(async (force = false) => {
    setPolarLoading(true);
    try {
      const result = await fetchPolarTier(force);
      if (result !== undefined) setPolarTier(result);
    } finally {
      setPolarLoading(false);
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchAndSync();
  }, [fetchAndSync]);

  // Stable identity: callers hold refetch in dependency arrays.
  const refetch = useCallback(() => { void fetchAndSync(true); }, [fetchAndSync]);

  // Refetch on window focus (user returns from checkout)
  useEffect(() => {
    function onFocus() { fetchAndSync(true); }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchAndSync]);

  // Refetch on ?upgraded=true
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.search.includes("upgraded=true")) {
      const timer = setTimeout(() => fetchAndSync(true), 1500);
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
  const grantUntil = convexTier?.grantUntil ?? null;
  const grantSource = convexTier?.grantSource ?? null;

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
    grantUntil,
    grantSource,
    refetch,
    ...TIER_LIMITS[tier],
  };
}
