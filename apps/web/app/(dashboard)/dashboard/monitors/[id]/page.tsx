"use client";

import { use } from "react";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
} from "lucide-react";
import Link from "next/link";
import { mockMonitors, mockResults } from "@/lib/mock-data";

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
  const monitor = mockMonitors.find((m) => m._id === id);
  if (!monitor) return notFound();

  const results = mockResults.filter((r) => r.monitorId === id);

  return (
    <div className="space-y-8">
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
          <p className="text-muted-foreground mt-0.5">&ldquo;{monitor.prompt}&rdquo;</p>
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
        <Card className="border-border/50 bg-card/50">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Globe className="h-4 w-4" />
              URL
            </div>
            <a
              href={monitor.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline flex items-center gap-1"
            >
              {new URL(monitor.url).hostname}
              <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        </Card>
        <Card className="border-border/50 bg-card/50">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Clock className="h-4 w-4" />
              Check Interval
            </div>
            <p className="text-sm font-medium">Every {monitor.checkInterval}</p>
          </CardContent>
        </Card>
        <Card className="border-border/50 bg-card/50">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Zap className="h-4 w-4" />
              Matches
            </div>
            <p className="text-sm font-medium">{monitor.matchCount} total</p>
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-4">Scrape History</h2>
        {results.length === 0 ? (
          <Card className="border-border/50 bg-card/50">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">No scrape results yet</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {results.map((result) => (
              <Card key={result._id} className="border-border/50 bg-card/50">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {result.hasNewMatches ? (
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/10">
                          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        </div>
                      ) : result.error ? (
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-red-500/10">
                          <XCircle className="h-4 w-4 text-red-400" />
                        </div>
                      ) : (
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                          <Clock className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-medium">
                          {result.hasNewMatches
                            ? `${result.matches.length} match${result.matches.length !== 1 ? "es" : ""} found`
                            : result.error
                              ? "Scrape failed"
                              : "No matches"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(result.scrapedAt)} &middot; {result.totalItems} items scanned
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
                      <Separator className="my-3" />
                      <div className="space-y-2">
                        {result.matches.map((match, i) => (
                          <div
                            key={i}
                            className="rounded-lg bg-background/50 p-3 text-sm font-mono"
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
