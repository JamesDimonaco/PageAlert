"use client";

import { use } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/prowl/status-badge";
import {
  ArrowLeft,
  ExternalLink,
  Clock,
  Globe,
  Zap,
  Play,
  Pause,
  Pencil,
  Trash2,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { useMonitor, useMonitorResults } from "@/hooks/use-monitors";
import type { Id } from "@/convex/_generated/dataModel";

function timeAgo(timestamp?: number): string {
  if (!timestamp) return "Never";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export default function MonitorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const monitor = useMonitor(id as Id<"monitors">);
  const results = useMonitorResults(id as Id<"monitors">);

  if (monitor === undefined) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (monitor === null) {
    return (
      <div className="flex flex-col items-center justify-center py-32">
        <p className="text-lg font-semibold mb-2">Monitor not found</p>
        <Link href="/dashboard">
          <Button variant="outline">Back to dashboard</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <div className="flex items-center gap-4">
        <Link href="/dashboard">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{monitor.name}</h1>
            <StatusBadge status={monitor.status} />
          </div>
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">&ldquo;{monitor.prompt}&rdquo;</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5">
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5">
            {monitor.status === "paused" ? (
              <>
                <Play className="h-3.5 w-3.5" />
                Resume
              </>
            ) : (
              <>
                <Pause className="h-3.5 w-3.5" />
                Pause
              </>
            )}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5 text-destructive hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
              <Globe className="h-3.5 w-3.5" />
              URL
            </div>
            <a
              href={monitor.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-primary hover:underline flex items-center gap-1.5"
            >
              {new URL(monitor.url).hostname}
              <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
              <Clock className="h-3.5 w-3.5" />
              Check Interval
            </div>
            <p className="text-sm font-semibold">Every {monitor.checkInterval}</p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
              <Zap className="h-3.5 w-3.5" />
              Matches
            </div>
            <p className="text-sm font-semibold">{monitor.matchCount} total</p>
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-xl font-bold tracking-tight mb-6">Scrape History</h2>
        {results.length === 0 ? (
          <Card className="border-border/30 bg-card/30 shadow-sm shadow-black/5">
            <CardContent className="py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/30 mx-auto mb-4">
                <Clock className="h-5 w-5 text-muted-foreground/60" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">No scrape results yet</p>
              <p className="text-xs text-muted-foreground/70 mt-1">Results will appear here after the first check</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {results.map((result) => (
              <Card key={result._id} className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      {result.hasNewMatches ? (
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/10">
                          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        </div>
                      ) : result.error ? (
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500/10">
                          <XCircle className="h-4 w-4 text-red-400" />
                        </div>
                      ) : (
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/50">
                          <Clock className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-semibold">
                          {result.hasNewMatches
                            ? `${result.matches.length} match${result.matches.length !== 1 ? "es" : ""} found`
                            : result.error
                              ? "Scrape failed"
                              : "No matches"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {formatDate(result.scrapedAt)} · {result.totalItems} items scanned
                        </p>
                      </div>
                    </div>
                    {result.hasNewMatches && (
                      <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                        New matches
                      </Badge>
                    )}
                  </div>

                  {result.matches.length > 0 && (
                    <>
                      <Separator className="my-4" />
                      <div className="space-y-2">
                        {result.matches.map((match: Record<string, unknown>, i: number) => (
                          <div
                            key={i}
                            className="rounded-lg bg-background/50 p-4 text-sm font-mono shadow-sm shadow-black/5"
                          >
                            {JSON.stringify(match, null, 2)}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
