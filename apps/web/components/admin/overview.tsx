"use client";

import { useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUsd } from "./format";

function Tile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
      <CardContent className="p-4 sm:p-5">
        <p className="text-2xl sm:text-3xl font-bold tracking-tight tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground mt-1 font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground/70 mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function AdminOverview() {
  const data = useQuery(api.admin.overview);

  if (!data) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { users, tiers, monitors, scans } = data;
  const paying = tiers.pro + tiers.max - tiers.trials;
  const maxSignups = Math.max(1, ...users.signupsByDay.map((d) => d.count));
  const scanSuccessPct = scans.sampled > 0 ? Math.round((scans.success / scans.sampled) * 100) : null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="MRR" value={formatUsd(tiers.mrrCents)} hint={tiers.cancelling > 0 ? `${tiers.cancelling} cancelling` : undefined} />
        <Tile label="Paying users" value={paying} hint={tiers.trials > 0 ? `${tiers.trials} on trial` : undefined} />
        <Tile label="Users" value={users.total} hint={`+${users.new7d} this week`} />
        <Tile label="Monitors" value={monitors.total} hint={`+${monitors.new7d} this week`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5 lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Signups, last 30 days</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-0.5 h-28" role="img" aria-label={`${users.new30d} signups in the last 30 days`}>
              {users.signupsByDay.map((d) => (
                <div
                  key={d.day}
                  className="flex-1 bg-primary/70 hover:bg-primary rounded-t-[2px] min-h-[2px]"
                  style={{ height: `${Math.max(2, (d.count / maxSignups) * 100)}%` }}
                  title={`${d.day}: ${d.count}`}
                />
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>{users.signupsByDay[0]?.day}</span>
              <span>{users.new30d} total</span>
              <span>{users.signupsByDay[users.signupsByDay.length - 1]?.day}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Plans</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border/30">
            <Row label="Free" value={tiers.free} />
            <Row label="Pro" value={tiers.pro} />
            <Row label="Max" value={tiers.max} />
            <Row label="On trial" value={tiers.trials} />
            <Row label="Cancelling" value={tiers.cancelling} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Monitors</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border/30">
            <Row label="Active" value={monitors.active} />
            <Row label="Scanning" value={monitors.scanning} />
            <Row label="Paused" value={monitors.paused} />
            <Row label="Error" value={monitors.error} />
            <Row label="Anonymous (try page)" value={monitors.anonymous} />
            <Row label="Total checks" value={monitors.totalChecks.toLocaleString()} />
            <Row label="Total matches" value={monitors.totalMatches.toLocaleString()} />
          </CardContent>
        </Card>

        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Scan health, last {scans.sampled} scans</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border/30">
            <Row label="Success rate" value={scanSuccessPct === null ? "–" : `${scanSuccessPct}%`} />
            <Row label="Success" value={scans.success} />
            <Row label="Error" value={scans.error} />
            <Row label="Timeout" value={scans.timeout} />
            <Row label="Blocked by site" value={scans.blocked} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
