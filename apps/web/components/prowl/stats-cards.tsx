"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Activity, Zap, AlertTriangle, Clock } from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";

export function StatsCards({ monitors }: { monitors: Doc<"monitors">[] }) {
  const active = monitors.filter((m) => m.status === "active").length;
  const totalMatches = monitors.reduce((sum, m) => sum + m.matchCount, 0);
  const errors = monitors.filter((m) => m.status === "error").length;
  const totalChecks = monitors.reduce((sum, m) => sum + (m.checkCount ?? 0), 0);

  const stats = [
    {
      label: "Active Monitors",
      value: active,
      icon: Activity,
      color: "text-emerald-400",
      bg: "bg-emerald-500/10",
    },
    {
      label: "Total Matches",
      value: totalMatches,
      icon: Zap,
      color: "text-primary",
      bg: "bg-primary/10",
    },
    {
      label: "Total Checks",
      value: totalChecks,
      icon: Clock,
      color: "text-blue-400",
      bg: "bg-blue-500/10",
    },
    {
      label: "Errors",
      value: errors,
      icon: AlertTriangle,
      color: "text-red-400",
      bg: "bg-red-500/10",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {stats.map((stat) => (
        <Card key={stat.label} className="border-border/30 bg-card/50 shadow-sm shadow-black/5 backdrop-blur">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-start justify-between mb-2 sm:mb-3">
              <div className={`flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg ${stat.bg}`}>
                <stat.icon className={`h-4 w-4 sm:h-5 sm:w-5 ${stat.color}`} />
              </div>
            </div>
            <p className="text-2xl sm:text-3xl font-bold tracking-tight tabular-nums">{stat.value}</p>
            <p className="text-xs text-muted-foreground mt-1 font-medium">{stat.label}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
