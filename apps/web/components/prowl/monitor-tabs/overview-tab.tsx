"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { AiInsightsCard } from "@/components/prowl/ai-insights";
import { PriceAlertCard } from "@/components/prowl/price-alert-card";
import { IntervalSelector } from "@/components/prowl/interval-selector";
import { ChannelSelector } from "@/components/prowl/channel-selector";
import {
  ExternalLink,
  Clock,
  Zap,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Quote,
  Pencil,
  X,
  Save,
  Loader2,
  AlertTriangle,
  RotateCw,
  Bell,
  BellOff,
  TrendingDown,
  BarChart3,
} from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import type { ExtractedItem, ExtractionSchema } from "@prowl/shared";
import { getItemKey } from "@prowl/shared";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { timeAgo } from "@/lib/time";
import { formatPrice, toSafeUrl } from "@/lib/format";
import { toast } from "sonner";

interface OverviewTabProps {
  monitorId: Id<"monitors">;
  monitor: {
    name: string;
    url: string;
    prompt: string;
    checkInterval: string;
    lastCheckedAt?: number;
    matchCount: number;
    checkCount?: number;
    schema?: unknown;
    status: string;
    lastError?: string;
    retryCount?: number;
    nextCheckAt?: number;
    notificationChannels?: string[];
  };
  matches: ExtractedItem[];
  allItems: ExtractedItem[];
  totalItems: number;
  onRescan?: (id: Id<"monitors">) => Promise<void>;
  onToggleMute?: () => Promise<unknown>;
}

const RETRY_LIMIT = 3;
const RETRY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export function OverviewTab({ monitorId, monitor, matches, allItems, totalItems, onRescan, onToggleMute }: OverviewTabProps) {
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Persist retry timestamps to localStorage so limit survives refresh
  const storageKey = `pagealert_retry_${monitorId}`;
  const [retryTimestamps, setRetryTimestamps] = useState<number[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const stored = localStorage.getItem(storageKey);
      if (!stored) return [];
      const parsed = JSON.parse(stored) as number[];
      return parsed.filter((t) => Date.now() - t < RETRY_WINDOW_MS);
    } catch { return []; }
  });

  useEffect(() => {
    const pruned = retryTimestamps.filter((t) => Date.now() - t < RETRY_WINDOW_MS);
    localStorage.setItem(storageKey, JSON.stringify(pruned));
  }, [retryTimestamps, storageKey]);

  const recentRetries = retryTimestamps.filter((t) => Date.now() - t < RETRY_WINDOW_MS);
  const canRetry = monitor.status === "error" && onRescan && recentRetries.length < RETRY_LIMIT && !retrying;

  async function handleRetry() {
    if (!canRetry) return;
    setRetrying(true);
    setRetryTimestamps((prev) => [...prev, Date.now()]);
    try {
      await onRescan!(monitorId);
    } finally {
      setRetrying(false);
    }
  }

  // Edit state
  const [editName, setEditName] = useState(monitor.name);
  const [editPrompt, setEditPrompt] = useState(monitor.prompt);
  const [editInterval, setEditInterval] = useState(monitor.checkInterval as "5m" | "15m" | "30m" | "1h" | "6h" | "24h");
  const [editChannels, setEditChannels] = useState<("email" | "telegram" | "discord")[]>(
    (monitor.notificationChannels as ("email" | "telegram" | "discord")[]) ?? ["email"]
  );
  const [channelsTouched, setChannelsTouched] = useState(false);

  const updateMutation = useMutation(api.monitors.update);
  const schema = monitor.schema as ExtractionSchema | undefined;

  const insights = schema?.insights;
  const tracksPrices = insights?.tracksPrices
    ?? allItems.some((item) => typeof item.price === "number");
  const suggestedPriceTrackItems = insights?.suggestedPriceTrackItems ?? [];
  const priceAlerts = (monitor as any).priceAlerts;

  const currency = (() => {
    const currencies = allItems
      .map((i) => typeof i.currency === "string" ? i.currency : null)
      .filter((c): c is string => c !== null);
    if (currencies.length === 0) return "USD";
    const counts = new Map<string, number>();
    for (const c of currencies) counts.set(c, (counts.get(c) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  })();

  const lowestTrackedPrice = (() => {
    if (!tracksPrices || !priceAlerts?.trackedItems?.length) return null;
    const trackedSet = new Set(priceAlerts.trackedItems);
    const trackedWithPrices = allItems.filter((item) => {
      const key = getItemKey(item);
      return trackedSet.has(key) && typeof item.price === "number";
    });
    if (trackedWithPrices.length === 0) return null;
    const lowest = Math.min(...trackedWithPrices.map((i) => i.price as number));
    return formatPrice(lowest, currency);
  })();

  function startEditing() {
    setEditName(monitor.name);
    setEditPrompt(monitor.prompt);
    setEditInterval(monitor.checkInterval as "5m" | "15m" | "30m" | "1h" | "6h" | "24h");
    setEditChannels((monitor.notificationChannels as ("email" | "telegram" | "discord")[]) ?? ["email"]);
    setChannelsTouched(false);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
  }

  async function saveEdits() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        id: monitorId,
        name: editName.trim(),
        prompt: editPrompt.trim(),
      };
      if (channelsTouched) {
        payload.notificationChannels = editChannels;
      }
      if (editInterval !== monitor.checkInterval) {
        payload.checkInterval = editInterval;
      }
      await updateMutation(payload as Parameters<typeof updateMutation>[0]);
      setEditing(false);
      toast.success("Monitor updated");
    } catch (e) {
      toast.error("Failed to update", { description: e instanceof Error ? e.message : "" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      {(monitor as any).muted && (
        <Card className="border-amber-500/30 bg-amber-500/5 shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <BellOff className="h-5 w-5 text-amber-400 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-amber-400">Notifications muted</p>
                  <p className="text-xs text-muted-foreground">This monitor is still scanning but won't send any alerts.</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 shrink-0 border-amber-500/20 hover:bg-amber-500/10"
                onClick={() => onToggleMute?.()}
              >
                <Bell className="h-3.5 w-3.5" />
                Unmute
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Retry in progress banner — monitor is active but has failed checks being retried */}
      {monitor.status === "active" && (monitor.retryCount ?? 0) > 0 && monitor.lastError && (
        <Card className="border-amber-500/30 bg-amber-500/5 shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <RotateCw className="h-5 w-5 text-amber-400 shrink-0 mt-0.5 animate-spin" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-amber-400 mb-1">
                  Retrying automatically ({monitor.retryCount} of 3)
                </p>
                <p className="text-sm text-muted-foreground break-words">{monitor.lastError}</p>
                <p className="text-xs text-muted-foreground/60 mt-2">
                  Trying different strategies — proxy, mobile browser.
                  {monitor.retryCount === 1 && " Next: retry with residential proxy."}
                  {monitor.retryCount === 2 && " Next: retry with mobile browser + skip anti-bot checks."}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error banner */}
      {monitor.status === "error" && monitor.lastError && (() => {
        const err = monitor.lastError.toLowerCase();
        const isBlocked = err.includes("blocking") || err.includes("captcha") || err.includes("anti-bot") || err.includes("blocked");
        return (
        <Card className="border-red-500/30 bg-red-500/5 shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-red-400 mb-1">
                  {isBlocked ? "Site is blocking access" : "Monitor failed"}
                </p>
                <p className="text-sm text-muted-foreground break-words">{monitor.lastError}</p>
                <p className="text-xs text-muted-foreground/60 mt-2">
                  {isBlocked
                    ? "All retry strategies (proxy, mobile browser) were exhausted. Try a different URL for this site, or check if the page works without login."
                    : "Try pausing other monitors, checking the URL is accessible, or simplifying your prompt."}
                </p>
              </div>
              {onRescan && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 shrink-0 border-red-500/20 hover:bg-red-500/10"
                  disabled={!canRetry}
                  onClick={handleRetry}
                >
                  {retrying ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCw className="h-3.5 w-3.5" />
                  )}
                  {retrying ? "Retrying..." : `Retry${recentRetries.length > 0 ? ` (${RETRY_LIMIT - recentRetries.length} left)` : ""}`}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
        );
      })()}

      {/* Prompt + Edit */}
      <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
        <CardContent className="p-6">
          {editing ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">Name</Label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">What are you looking for?</Label>
                <Textarea
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">
                  Note: changing the prompt won&apos;t rescan automatically. You&apos;ll need to rescan to apply changes.
                </p>
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">Check frequency</Label>
                <IntervalSelector value={editInterval} onValueChange={setEditInterval} />
              </div>
              <ChannelSelector value={editChannels} onChange={(c) => { setEditChannels(c); setChannelsTouched(true); }} monitorId={monitorId} />
              <div className="flex items-center gap-2 pt-2">
                <Button size="sm" className="gap-1.5" onClick={saveEdits} disabled={saving}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEditing} disabled={saving}>
                  <X className="h-3.5 w-3.5 mr-1" /> Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 flex-1">
                <Quote className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">Looking for</p>
                  <p className="text-base font-medium leading-relaxed">{monitor.prompt}</p>
                </div>
              </div>
              <Button variant="ghost" size="sm" className="gap-1.5 shrink-0" onClick={startEditing}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stats row */}
      <div className={`grid gap-4 ${tracksPrices ? "grid-cols-2 md:grid-cols-3 lg:grid-cols-6" : "grid-cols-2 md:grid-cols-4"}`}>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-4 sm:p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">URL</p>
            <a href={monitor.url} target="_blank" rel="noopener noreferrer"
              className="text-sm font-medium text-primary hover:underline flex items-center gap-1.5 break-all">
              {monitor.url.replace(/^https?:\/\//, "")}
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-4 sm:p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Interval</p>
            <p className="text-sm font-semibold flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              Every {monitor.checkInterval}
            </p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-4 sm:p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Matches</p>
            <p className="text-sm font-semibold flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-primary" />
              {matches.length} of {totalItems} items
            </p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-4 sm:p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Checks</p>
            <p className="text-sm font-semibold">{monitor.checkCount ?? 0} total · {timeAgo(monitor.lastCheckedAt)}</p>
          </CardContent>
        </Card>
        {tracksPrices && (
          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardContent className="p-4 sm:p-5">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Lowest Price</p>
              <p className="text-sm font-semibold flex items-center gap-1.5">
                <TrendingDown className="h-3.5 w-3.5 text-emerald-400" />
                {lowestTrackedPrice ?? "—"}
              </p>
            </CardContent>
          </Card>
        )}
        {tracksPrices && (
          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardContent className="p-4 sm:p-5">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Tracking</p>
              <p className="text-sm font-semibold">
                {priceAlerts?.trackedItems?.length ?? 0} items
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {tracksPrices && !priceAlerts && (
        <Card className="border-primary/20 bg-primary/5 shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <BarChart3 className="h-5 w-5 text-primary shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-semibold">This page has prices — track price changes?</p>
                <p className="text-xs text-muted-foreground mt-0.5">Get notified when prices drop or cross your threshold. AI has suggested items to track.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {tracksPrices && (
        <PriceAlertCard
          monitorId={monitorId}
          priceAlerts={priceAlerts}
          allItems={allItems}
          suggestedPriceTrackItems={suggestedPriceTrackItems}
          currency={currency}
          muted={!!(monitor as any).muted}
        />
      )}

      {/* Top matches */}
      {matches.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            Top Matches
            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
              {matches.length}
            </Badge>
          </h3>
          <div className="space-y-2">
            {matches.slice(0, 5).map((item, i) => {
              const title = String(item.title ?? item.name ?? `Item ${i + 1}`);
              const safeUrl = toSafeUrl(item.url);
              const price = formatPrice(item.price, item.currency);
              return (
                <Card key={i} className="border-emerald-500/20 bg-emerald-500/5 shadow-sm shadow-black/5">
                  <CardContent className="p-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {safeUrl ? (
                            <a href={safeUrl} target="_blank" rel="noopener noreferrer"
                              className="text-sm font-medium hover:text-primary hover:underline transition-colors break-words">
                              {title}
                            </a>
                          ) : (
                            <p className="text-sm font-medium break-words">{title}</p>
                          )}
                          {safeUrl && <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />}
                        </div>
                      </div>
                      {price && (
                        <span className="text-sm font-bold shrink-0">{price}</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {matches.length > 5 && (
              <p className="text-xs text-muted-foreground pl-2">+{matches.length - 5} more — see Items tab</p>
            )}
          </div>
        </div>
      )}

      {matches.length === 0 && totalItems > 0 && (
        <Card className="border-border/30 bg-card/30 shadow-sm shadow-black/5">
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium text-muted-foreground">No matches right now</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              {totalItems} items being monitored. You&apos;ll be notified when something matches.
            </p>
          </CardContent>
        </Card>
      )}

      {/* AI Insights - collapsible */}
      {schema?.insights && (
        <div>
          <button
            onClick={() => setInsightsOpen(!insightsOpen)}
            className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            {insightsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            AI Understanding
            <Badge variant="outline" className={`text-xs ml-1 ${
              (schema.insights.confidence ?? 0) >= 80
                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                : (schema.insights.confidence ?? 0) >= 50
                  ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                  : "bg-red-500/10 text-red-400 border-red-500/20"
            }`}>
              {schema.insights.confidence}%
            </Badge>
          </button>
          {insightsOpen && (
            <div className="mt-4">
              <AiInsightsCard insights={schema.insights} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
