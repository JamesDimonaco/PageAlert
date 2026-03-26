"use client";

import { authClient } from "@/lib/auth-client";
import { useState, useEffect } from "react";

export type Tier = "free" | "pro" | "business";

export const TIER_LIMITS: Record<Tier, {
  maxMonitors: number;
  minInterval: string;
  channels: string[];
  description: string;
}> = {
  free: { maxMonitors: 3, minInterval: "6h", channels: ["email"], description: "3 monitors, 6 hour checks, email only" },
  pro: { maxMonitors: 25, minInterval: "15m", channels: ["email", "telegram", "discord"], description: "25 monitors, 15 min checks, all channels" },
  business: { maxMonitors: 9999, minInterval: "5m", channels: ["email", "telegram", "discord", "webhook"], description: "Unlimited monitors, 5 min checks, API access" },
};

interface TierInfo {
  tier: Tier;
  isLoading: boolean;
  maxMonitors: number;
  minInterval: string;
  channels: string[];
  description: string;
}

export function useTier(): TierInfo {
  const [tier, setTier] = useState<Tier>("free");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchTier() {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client = authClient as any;
        const state = await client.customer?.state?.();
        if (state?.data?.activeSubscriptions) {
          const subs = state.data.activeSubscriptions;
          if (subs.some((s: { slug?: string }) => s.slug === "business")) {
            setTier("business");
          } else if (subs.some((s: { slug?: string }) => s.slug === "pro")) {
            setTier("pro");
          } else {
            setTier("free");
          }
        }
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.error("useTier: failed to fetch tier", err);
        }
      } finally {
        setIsLoading(false);
      }
    }
    fetchTier();
  }, []);

  return {
    tier,
    isLoading,
    ...TIER_LIMITS[tier],
  };
}
