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
      label: "Active",
      value: active,
      icon: Activity,
      color: "text-success",
      bg: "bg-emerald-500/10",
    },
    {
      label: "Matches",
      value: totalMatches,
      icon: Zap,
      color: "text-primary",
      bg: "bg-primary/10",
    },
    {
      label: "Checks",
      value: totalChecks,
      icon: Clock,
      color: "text-info",
      bg: "bg-blue-500/10",
    },
    {
      label: "Errors",
      value: errors,
      icon: AlertTriangle,
      color: "text-destructive",
      bg: "bg-red-500/10",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {stats.map((stat) => (
        <Card key={stat.label}>
          <CardContent className="flex items-center gap-3">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${stat.bg}`}>
              <stat.icon className={`h-5 w-5 ${stat.color}`} />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold leading-none tracking-tight tabular-nums">{stat.value}</p>
              <p className="mt-1 text-xs font-medium text-muted-foreground">{stat.label}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
