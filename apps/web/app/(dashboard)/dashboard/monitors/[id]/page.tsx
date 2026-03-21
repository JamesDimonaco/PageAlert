"use client";

import { use, useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/prowl/status-badge";
import { MatchConditionsEditor } from "@/components/prowl/match-conditions-editor";
import { AiInsightsCard } from "@/components/prowl/ai-insights";
import {
  ArrowLeft,
  ExternalLink,
  Clock,
  Globe,
  Zap,
  Play,
  Pause,
  Trash2,
  CheckCircle2,
  XCircle,
  Loader2,
  Save,
  Search,
  Ban,
  RotateCcw,
  RefreshCw,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMonitor, useMonitorResults, useMonitors } from "@/hooks/use-monitors";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { DeleteDialog } from "@/components/prowl/delete-dialog";
import { applyMatchConditions } from "@prowl/shared";
import type { Id } from "@/convex/_generated/dataModel";
import type { MatchConditions, ExtractedItem, ExtractionSchema } from "@prowl/shared";
import { toast } from "sonner";

function timeAgo(timestamp?: number): string {
  if (!timestamp) return "Never";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function MonitorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const monitorId = id as Id<"monitors">;
  const monitor = useMonitor(monitorId);
  const results = useMonitorResults(monitorId);
  const { togglePause, deleteMonitor } = useMonitors();
  const updateMutation = useMutation(api.monitors.update);
  const router = useRouter();

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editedConditions, setEditedConditions] = useState<MatchConditions | null>(null);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const updateBlacklist = useMutation(api.monitors.updateBlacklist);

  // Derive all computed values before any early returns (rules of hooks)
  const schema = monitor?.schema as ExtractionSchema | undefined;
  const allItems = (schema?.items ?? []) as ExtractedItem[];
  const blacklist = ((monitor as Record<string, unknown>)?.blacklistedItems ?? []) as string[];
  const conditions = editedConditions ?? schema?.matchConditions ?? {};
  const matchesBeforeBlacklist = allItems.length > 0 ? applyMatchConditions(allItems, conditions) : [];

  function getItemKey(item: ExtractedItem): string {
    return String(item.title ?? item.name ?? "");
  }

  const matches = matchesBeforeBlacklist.filter(
    (item) => !blacklist.includes(getItemKey(item))
  );
  const hasEdits = editedConditions !== null;

  const filteredItems = useMemo(() => {
    if (!searchQuery) return allItems;
    const q = searchQuery.toLowerCase();
    return allItems.filter((item) =>
      JSON.stringify(item).toLowerCase().includes(q)
    );
  }, [allItems, searchQuery]);

  const sortedItems = useMemo(() => {
    return [...filteredItems].sort((a, b) => {
      const aBlacklisted = blacklist.includes(getItemKey(a));
      const bBlacklisted = blacklist.includes(getItemKey(b));
      if (aBlacklisted !== bBlacklisted) return aBlacklisted ? 1 : -1;

      const aMatch = matches.some((m) => getItemKey(m) === getItemKey(a));
      const bMatch = matches.some((m) => getItemKey(m) === getItemKey(b));
      if (aMatch !== bMatch) return aMatch ? -1 : 1;
      return 0;
    });
  }, [filteredItems, matches, blacklist]);

  // Early returns AFTER all hooks
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

  async function saveConditions() {
    if (!schema || !editedConditions) return;
    setSaving(true);
    try {
      await updateMutation({
        id: monitorId,
        schema: { ...schema, matchConditions: editedConditions },
      });
      setEditedConditions(null);
      toast.success("Filters updated");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function blacklistItem(title: string) {
    await updateBlacklist({ id: monitorId, blacklistedItems: [...blacklist, title] });
    toast.success("Item dismissed");
  }

  async function unblacklistItem(title: string) {
    await updateBlacklist({ id: monitorId, blacklistedItems: blacklist.filter((t) => t !== title) });
    toast.success("Item restored");
  }

  return (
    <div className="space-y-10">
      {/* Header */}
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
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
            &ldquo;{monitor.prompt}&rdquo;
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              togglePause(monitorId);
              toast.success(monitor.status === "paused" ? "Monitor resumed" : "Monitor paused");
            }}
          >
            {monitor.status === "paused" ? (
              <><Play className="h-3.5 w-3.5" /> Resume</>
            ) : (
              <><Pause className="h-3.5 w-3.5" /> Pause</>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </div>
      </div>

      {/* Info cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">URL</p>
            <a href={monitor.url} target="_blank" rel="noopener noreferrer"
              className="text-sm font-medium text-primary hover:underline flex items-center gap-1.5">
              {new URL(monitor.url).hostname}
              <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Interval</p>
            <p className="text-sm font-semibold">Every {monitor.checkInterval}</p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Matches</p>
            <p className="text-sm font-semibold">{matches.length} of {allItems.length} items</p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Last Check</p>
            <p className="text-sm font-semibold">{timeAgo(monitor.lastCheckedAt)}</p>
          </CardContent>
        </Card>
      </div>

      {/* AI Insights */}
      {schema?.insights && <AiInsightsCard insights={schema.insights} />}

      {/* Match Filters */}
      {schema && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold tracking-tight">Filters</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Edit keywords to re-filter the existing data. No new scrape needed.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {hasEdits && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setEditedConditions(null)}>
                    <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Discard
                  </Button>
                  <Button size="sm" className="gap-1.5" onClick={saveConditions} disabled={saving}>
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save & Apply
                  </Button>
                </>
              )}
            </div>
          </div>
          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardContent className="p-6">
              <MatchConditionsEditor conditions={conditions} onChange={setEditedConditions} />
              {hasEdits && (
                <p className="text-xs text-primary mt-4 flex items-center gap-1.5">
                  <RefreshCw className="h-3 w-3" />
                  Preview updated below — click &ldquo;Save & Apply&rdquo; to keep these changes
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Blacklisted Items */}
      {blacklist.length > 0 && (
        <div>
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-lg font-bold tracking-tight">Dismissed Items</h2>
            <Badge variant="outline" className="text-xs">{blacklist.length}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            These items won&apos;t trigger notifications even if they match your filters.
          </p>
          <div className="flex flex-wrap gap-2">
            {blacklist.map((title) => (
              <Badge key={title} variant="outline" className="gap-1.5 pl-2.5 pr-1 py-1 text-xs font-normal max-w-xs truncate">
                <Ban className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="truncate">{title}</span>
                <button
                  onClick={() => unblacklistItem(title)}
                  className="ml-1 rounded-full hover:bg-muted p-0.5 shrink-0"
                  title="Restore this item"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Extracted Items */}
      {allItems.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-bold tracking-tight">Items</h2>
              <Badge variant="outline" className="text-xs">{filteredItems.length} shown</Badge>
              {matches.length > 0 && (
                <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
                  {matches.length} match{matches.length !== 1 ? "es" : ""}
                </Badge>
              )}
            </div>
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search items..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-8 text-sm"
              />
            </div>
          </div>

          <div className="space-y-2 max-h-[600px] overflow-y-auto">
            {sortedItems.map((item, i) => {
              const key = getItemKey(item);
              const title = key || `Item ${i + 1}`;
              const isMatch = matches.some((m) => getItemKey(m) === key);
              const isBlacklisted = blacklist.includes(key);
              const itemUrl = item.url ? String(item.url) : null;

              return (
                <Card
                  key={key || i}
                  className={`border-border/30 shadow-sm shadow-black/5 transition-colors ${
                    isBlacklisted
                      ? "bg-card/20 opacity-40 border-l-2 border-l-muted-foreground/20"
                      : isMatch
                        ? "bg-emerald-500/5 border-l-2 border-l-emerald-500/40"
                        : "bg-card/30 opacity-60"
                  }`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {itemUrl ? (
                            <a
                              href={itemUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm font-medium hover:text-primary hover:underline transition-colors truncate"
                            >
                              {title}
                            </a>
                          ) : (
                            <p className="text-sm font-medium truncate">{title}</p>
                          )}
                          {itemUrl && <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />}
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                          {item.price != null && (
                            <span className="text-sm font-semibold">${Number(item.price).toLocaleString()}</span>
                          )}
                          {item.originalPrice != null && (
                            <span className="text-xs text-muted-foreground line-through">
                              ${Number(item.originalPrice).toLocaleString()}
                            </span>
                          )}
                          {item.savings != null && Number(item.savings) > 0 && (
                            <span className="text-xs text-emerald-400 font-medium">
                              Save ${Number(item.savings).toLocaleString()}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {isBlacklisted ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs gap-1"
                            onClick={() => unblacklistItem(key)}
                          >
                            <RotateCcw className="h-3 w-3" /> Restore
                          </Button>
                        ) : isMatch ? (
                          <>
                            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
                              <CheckCircle2 className="h-3 w-3 mr-1" /> Match
                            </Badge>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
                              onClick={() => blacklistItem(key)}
                              title="Dismiss this match"
                            >
                              <Ban className="h-3 w-3" /> Dismiss
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Scrape History */}
      {results.length > 0 && (
        <div>
          <h2 className="text-lg font-bold tracking-tight mb-4">History</h2>
          <div className="space-y-3">
            {results.map((result) => (
              <Card key={result._id} className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    {result.hasNewMatches ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                    ) : result.error ? (
                      <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                    ) : (
                      <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <div>
                      <p className="text-sm font-medium">
                        {result.hasNewMatches
                          ? `${result.matches.length} match${result.matches.length !== 1 ? "es" : ""}`
                          : result.error ? "Failed" : "No matches"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(result.scrapedAt).toLocaleString()} · {result.totalItems} items
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <DeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={() => {
          deleteMonitor(monitorId);
          toast.success("Monitor deleted");
          router.push("/dashboard");
        }}
        monitorName={monitor.name}
      />
    </div>
  );
}
