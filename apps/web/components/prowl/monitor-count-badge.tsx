"use client";

import { Zap } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function MonitorCountBadge() {
  const totalMonitors = useQuery(api.monitors.publicCount);

  if (!totalMonitors || totalMonitors <= 0) return null;

  return (
    <span className="flex items-center gap-1.5">
      <Zap className="h-3.5 w-3.5" />
      {totalMonitors.toLocaleString()} monitors created
    </span>
  );
}
