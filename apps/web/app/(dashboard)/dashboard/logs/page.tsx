"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import Link from "next/link";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const statusConfig = {
  success: { icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-500/10", label: "Success" },
  error: { icon: XCircle, color: "text-red-400", bg: "bg-red-500/10", label: "Error" },
  timeout: { icon: AlertTriangle, color: "text-amber-400", bg: "bg-amber-500/10", label: "Timeout" },
};

export default function LogsPage() {
  const logs = useQuery(api.logs.list, { limit: 100 });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Scrape Logs</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          Debug log of all scrape attempts with raw AI responses
        </p>
      </div>

      {logs === undefined ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl bg-card/30 py-20">
          <Clock className="h-8 w-8 text-muted-foreground mb-4" />
          <p className="text-sm text-muted-foreground">No scrape logs yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {logs.map((log) => {
            const config = statusConfig[log.status];
            const Icon = config.icon;
            return (
              <Link key={log._id} href={`/dashboard/logs/${log._id}`}>
                <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5 hover:bg-card/80 transition-colors cursor-pointer">
                  <CardContent className="p-4 sm:p-5">
                    <div className="flex items-start sm:items-center justify-between gap-3">
                      <div className="flex items-start sm:items-center gap-3 sm:gap-4 min-w-0">
                        <div className={`flex h-9 w-9 items-center justify-center rounded-full ${config.bg} shrink-0`}>
                          <Icon className={`h-4 w-4 ${config.color}`} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium truncate max-w-[200px] sm:max-w-md">
                              {log.url}
                            </p>
                            <Badge
                              variant="outline"
                              className={`text-xs ${
                                log.status === "success"
                                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                  : log.status === "timeout"
                                    ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                    : "bg-red-500/10 text-red-400 border-red-500/20"
                              }`}
                            >
                              {config.label}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs text-muted-foreground">
                            <span>{new Date(log.createdAt).toLocaleString()}</span>
                            <span>{formatDuration(log.durationMs)}</span>
                            {log.itemCount != null && <span>{log.itemCount} items</span>}
                            {log.matchCount != null && <span>{log.matchCount} matches</span>}
                            {(log as unknown as { aiConfidence?: number }).aiConfidence != null && (
                              <span>{(log as unknown as { aiConfidence?: number }).aiConfidence}% confidence</span>
                            )}
                            {log.error && (
                              <span className="text-red-400 truncate max-w-xs">{log.error}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
