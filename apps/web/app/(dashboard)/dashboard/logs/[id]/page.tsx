"use client";

import { use, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

import { formatStrategy } from "@/lib/strategy";

// Extended log type until Convex regenerates types with new fields
interface LogExtended {
  monitorName?: string;
  aiConfidence?: number;
  aiUnderstanding?: string;
  aiMatchSignal?: string;
  aiNoMatchSignal?: string;
  aiNotices?: string[];
  matchConditions?: unknown;
  strategy?: string;
  blocked?: boolean;
  blockReason?: string;
  retryAttempt?: number;
  [key: string]: unknown;
}
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Code,
  Eye,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCreateMonitor } from "@/hooks/use-create-monitor";
import type { Id } from "@/convex/_generated/dataModel";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function LogDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const rawLog = useQuery(api.logs.get, { id: id as Id<"scrapeLogs"> });
  const log = rawLog as (typeof rawLog & LogExtended) | null | undefined;
  const [showRaw, setShowRaw] = useState(false);
  const { open: openCreate } = useCreateMonitor();
  const router = useRouter();

  if (log === undefined) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (log === null) {
    return (
      <div className="flex flex-col items-center justify-center py-32">
        <p className="text-lg font-semibold mb-2">Log not found</p>
        <Link href="/dashboard/logs">
          <Button variant="outline">Back to logs</Button>
        </Link>
      </div>
    );
  }

  const statusConfig = {
    success: { icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-500/10", label: "Success" },
    error: { icon: XCircle, color: "text-red-400", bg: "bg-red-500/10", label: "Error" },
    timeout: { icon: AlertTriangle, color: "text-amber-400", bg: "bg-amber-500/10", label: "Timeout" },
  };

  const config = statusConfig[log.status];
  const Icon = config.icon;

  let parsedResponse: unknown = null;
  if (log.rawResponse) {
    try {
      parsedResponse = JSON.parse(log.rawResponse);
    } catch { /* */ }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start sm:items-center gap-3 sm:gap-4">
        <Link href="/dashboard/logs">
          <Button variant="ghost" size="icon" className="shrink-0">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">
              {log.monitorName ? log.monitorName : "Scrape Log"}
            </h1>
            <Badge
              variant="outline"
              className={`${
                log.status === "success"
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                  : log.status === "timeout"
                    ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                    : "bg-red-500/10 text-red-400 border-red-500/20"
              }`}
            >
              <Icon className="h-3 w-3 mr-1" />
              {config.label}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">{new Date(log.createdAt).toLocaleString()}</p>
        </div>
      </div>

      {/* Scan details */}
      {(log.strategy || log.blocked || (log.retryAttempt != null && log.retryAttempt > 0)) && (
        <div className="flex flex-wrap items-center gap-2">
          {log.strategy && (() => {
            const strat = formatStrategy(log.strategy);
            return <Badge variant="outline" className={`text-xs ${strat.color}`}>{strat.label}</Badge>;
          })()}
          {log.blocked && (
            <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-xs">
              Blocked{log.blockReason ? `: ${log.blockReason}` : ""}
            </Badge>
          )}
          {log.retryAttempt != null && log.retryAttempt > 0 && (
            <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-400 border-amber-500/20">
              Retry attempt {log.retryAttempt} of 3
            </Badge>
          )}
        </div>
      )}

      {/* Summary */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">URL</p>
            <p className="text-sm font-medium break-all">{log.url}</p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Duration</p>
            <p className="text-sm font-semibold">{formatDuration(log.durationMs)}</p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Items</p>
            <p className="text-sm font-semibold">{log.itemCount ?? "—"}</p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Matches</p>
            <p className="text-sm font-semibold">{log.matchCount ?? "—"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Prompt & Monitor Name */}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h2 className="text-lg font-bold tracking-tight mb-3">Prompt</h2>
          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardContent className="p-5">
              <p className="text-sm">&ldquo;{log.prompt}&rdquo;</p>
            </CardContent>
          </Card>
        </div>
        {log.monitorName && (
          <div>
            <h2 className="text-lg font-bold tracking-tight mb-3">Monitor Name</h2>
            <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
              <CardContent className="p-5">
                <p className="text-sm font-medium">{log.monitorName}</p>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* AI Insights */}
      {log.aiUnderstanding && (
        <div>
          <h2 className="text-lg font-bold tracking-tight mb-3">AI Insights</h2>
          <div className="space-y-3">
            <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
              <CardContent className="p-5 space-y-4">
                <div className="flex items-center gap-3">
                  <p className="text-sm font-semibold">Understanding</p>
                  {log.aiConfidence != null && (
                    <Badge variant="outline" className={`text-xs ${
                      (log.aiConfidence ?? 0) >= 80
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                        : (log.aiConfidence ?? 0) >= 50
                          ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                          : "bg-red-500/10 text-red-400 border-red-500/20"
                    }`}>
                      {log.aiConfidence}% confidence
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {log.aiUnderstanding}
                </p>

                {log.aiMatchSignal && (
                  <div className="grid gap-3 md:grid-cols-2 pt-2">
                    <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/10 p-3">
                      <p className="text-xs font-semibold text-emerald-400 mb-1">Match signal</p>
                      <p className="text-xs text-muted-foreground">{log.aiMatchSignal}</p>
                    </div>
                    <div className="rounded-lg bg-muted/30 border border-border/30 p-3">
                      <p className="text-xs font-semibold text-muted-foreground mb-1">No match signal</p>
                      <p className="text-xs text-muted-foreground">{log.aiNoMatchSignal}</p>
                    </div>
                  </div>
                )}

                {Array.isArray(log.aiNotices) &&
                  (log.aiNotices as string[]).length > 0 && (
                  <div className="rounded-lg bg-amber-500/5 border border-amber-500/10 p-3 mt-2">
                    <p className="text-xs font-semibold text-amber-400 mb-2">Notices</p>
                    <ul className="space-y-1">
                      {(log.aiNotices as string[]).map((n, i) => (
                        <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                          <span className="text-amber-400 shrink-0">•</span>
                          {n}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Match Conditions */}
      {log.matchConditions && (
        <div>
          <h2 className="text-lg font-bold tracking-tight mb-3">Generated Match Conditions</h2>
          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardContent className="p-5">
              <pre className="text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(log.matchConditions, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Error */}
      {log.error && (
        <div>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <h2 className="text-lg font-bold tracking-tight text-red-400">Error</h2>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => {
                if (log.monitorId) {
                  router.push(`/dashboard/monitors/${log.monitorId}`);
                } else {
                  openCreate();
                }
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {log.monitorId ? "View Monitor" : "Retry"}
            </Button>
          </div>
          <Card className="border-red-500/20 bg-red-500/5 shadow-sm shadow-black/5">
            <CardContent className="p-5">
              <p className="text-sm font-mono text-red-400">{log.error}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Monitor link */}
      {log.monitorId && (
        <Link
          href={`/dashboard/monitors/${log.monitorId}`}
          className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          View associated monitor →
        </Link>
      )}

      {/* Raw Response */}
      {log.rawResponse && (
        <div>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <h2 className="text-lg font-bold tracking-tight">Raw AI Response</h2>
            <div className="flex gap-2">
              <Button
                variant={showRaw ? "outline" : "default"}
                size="sm"
                className="gap-1.5"
                onClick={() => setShowRaw(false)}
              >
                <Eye className="h-3.5 w-3.5" />
                Formatted
              </Button>
              <Button
                variant={showRaw ? "default" : "outline"}
                size="sm"
                className="gap-1.5"
                onClick={() => setShowRaw(true)}
              >
                <Code className="h-3.5 w-3.5" />
                Raw
              </Button>
            </div>
          </div>

          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardContent className="p-5">
              <pre className="text-xs font-mono overflow-x-auto max-h-[600px] overflow-y-auto whitespace-pre-wrap break-all">
                {showRaw
                  ? log.rawResponse
                  : parsedResponse
                    ? JSON.stringify(parsedResponse, null, 2)
                    : log.rawResponse}
              </pre>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
