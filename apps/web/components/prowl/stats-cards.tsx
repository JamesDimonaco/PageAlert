"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Activity, Eye, Zap, AlertTriangle } from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";

export function StatsCards({ monitors }: { monitors: Doc<"monitors">[] }) {
  const active = monitors.filter((m) => m.status === "active").length;
  const matched = monitors.filter((m) => m.status === "matched").length;
  const totalMatches = monitors.reduce((sum, m) => sum + m.matchCount, 0);
  const errors = monitors.filter((m) => m.status === "error").length;

  const stats = [
    {
      label: "Active Monitors",
      value: active,
      icon: Activity,
      color: "text-emerald-400",
      bg: "bg-emerald-500/10",
    },
    {
      label: "Matches Found",
      value: totalMatches,
      icon: Zap,
      color: "text-primary",
      bg: "bg-primary/10",
    },
    {
      label: "Currently Matched",
      value: matched,
      icon: Eye,
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
          <CardContent className="p-6">
            <div className="flex items-start justify-between mb-3">
              <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${stat.bg}`}>
                <stat.icon className={`h-5 w-5 ${stat.color}`} />
              </div>
            </div>
            <p className="text-3xl font-bold tracking-tight tabular-nums">{stat.value}</p>
            <p className="text-xs text-muted-foreground mt-1 font-medium">{stat.label}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
