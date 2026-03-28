"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Lock } from "lucide-react";
import { useTier, type Tier } from "@/hooks/use-tier";

type CheckInterval = "5m" | "15m" | "30m" | "1h" | "6h" | "24h";

const INTERVALS: { value: CheckInterval; label: string; tier: Tier }[] = [
  { value: "5m", label: "Every 5 minutes", tier: "max" },
  { value: "15m", label: "Every 15 minutes", tier: "pro" },
  { value: "30m", label: "Every 30 minutes", tier: "pro" },
  { value: "1h", label: "Every hour", tier: "pro" },
  { value: "6h", label: "Every 6 hours", tier: "free" },
  { value: "24h", label: "Every 24 hours", tier: "free" },
];

function isAvailable(intervalTier: string, currentTier: Tier): boolean {
  if (currentTier === "max") return true;
  if (currentTier === "pro") return intervalTier !== "max";
  return intervalTier === "free";
}

interface IntervalSelectorProps {
  value: CheckInterval;
  onValueChange: (value: CheckInterval) => void;
  disabled?: boolean;
}

export function IntervalSelector({ value, onValueChange, disabled }: IntervalSelectorProps) {
  const { tier, isLoading } = useTier();

  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v && isAvailable(INTERVALS.find((i) => i.value === v)?.tier ?? "max", tier)) {
          onValueChange(v as CheckInterval);
        }
      }}
      disabled={disabled || isLoading}
    >
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {INTERVALS.map((interval) => {
          const available = isAvailable(interval.tier, tier);
          return (
            <SelectItem
              key={interval.value}
              value={interval.value}
              disabled={!available}
              className={!available ? "opacity-50" : ""}
            >
              <span className="flex items-center gap-2">
                {interval.label}
                {!available && (
                  <Badge variant="outline" className="text-[10px] gap-1 px-1.5 py-0">
                    <Lock className="h-2.5 w-2.5" />
                    {interval.tier === "pro" ? "Pro" : "Max"}
                  </Badge>
                )}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
