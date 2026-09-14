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
import { ChannelSelector, type Channel } from "@/components/prowl/channel-selector";
import {
  ExternalLink,
  List,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Settings2,
  X,
  Save,
  Loader2,
  AlertTriangle,
  RotateCw,
  Bell,
  BellOff,
  TrendingDown,
  TrendingUp,
  SlidersHorizontal,
} from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import type { Doc } from "@/convex/_generated/dataModel";
import { MAX_PROXY_BLOCKS } from "@/convex/shared";
import type { ExtractedItem, ExtractionSchema, PriceChange } from "@prowl/shared";
import { getItemKey, matchConfidence, MATCH_CONFIDENCE_LABEL } from "@prowl/shared";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { timeAgo, timeUntil } from "@/lib/time";
import { formatPrice, toSafeUrl } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { trackEvent } from "@/lib/posthog";

interface OverviewTabProps {
  monitorId: Id<"monitors">;
  monitor: {
    name: string;
    url: string;
    prompt: string;
    checkInterval: string;
    lastCheckedAt?: number;
    lastMatchAt?: number;
    matchCount: number;
    checkCount?: number;
    schema?: unknown;
    status: string;
    lastError?: string;
    retryCount?: number;
    proxyBlockCount?: number;
    nextCheckAt?: number;
    notificationChannels?: string[];
    proxyPreferred?: boolean;
  };
  matches: ExtractedItem[];
  allItems: ExtractedItem[];
  totalItems: number;
  results: Doc<"scrapeResults">[];
  scores: Record<string, { matchScore: number; matchReason: string }>;
  onRescan?: (id: Id<"monitors">) => Promise<void>;
  onToggleMute?: () => Promise<unknown>;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  onAdjustFilters: () => void;
  onViewItems: () => void;
  /** Check interval as the header shows it, already proxy-floored */
  displayInterval: string;
}

const RETRY_LIMIT = 3;
const RETRY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ROWS_SHOWN = 8;

export function OverviewTab({ monitorId, monitor, matches, allItems, totalItems, results, scores, onRescan, onToggleMute, settingsOpen, onSettingsOpenChange, onAdjustFilters, onViewItems, displayInterval }: OverviewTabProps) {
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Dismissing the low-confidence banner is per-monitor and sticky — a
  // monitor that works fine despite the number shouldn't nag forever.
  const lowConfDismissKey = `pagealert_lowconf_dismissed_${monitorId}`;
  const [lowConfDismissed, setLowConfDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(lowConfDismissKey) === "1";
    } catch { return false; }
  });
  function dismissLowConfidence() {
    setLowConfDismissed(true);
    try { localStorage.setItem(lowConfDismissKey, "1"); } catch { /* */ }
  }

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
  const [editChannels, setEditChannels] = useState<Channel[]>(
    (monitor.notificationChannels as Channel[]) ?? ["email"]
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

  // Titles that appeared on the most recent check. `changes.added` is the only
  // honest source: hasNewMatches is written from matchCount on the initial-scan
  // and full-extract paths, where the stored `matches` is every current match,
  // so keying off it badged the whole list as new. On the very first check
  // there is no previous result to diff, and everything really is new.
  const titleKey = (item: ExtractedItem) =>
    String(item.title ?? item.name ?? "").toLowerCase();
  // On a first scan everything is new, but 28 badges teaches the reader the
  // badge means nothing. Say it once above the list instead, so the badge only
  // ever means "appeared since your last alert".
  const isFirstScan = results.length <= 1;
  const newTitles = new Set<string>(
    isFirstScan
      ? []
      : ((results[0]?.changes?.added ?? []) as ExtractedItem[]).map(titleKey),
  );

  // Newest price change per title across the loaded results window, keyed by
  // lowercase title (the same join HistoryTab uses). Only kept when the change
  // landed on the price we are showing now, so a stale delta never appears.
  const priceChangeByTitle = new Map<string, PriceChange>();
  for (const r of results) {
    for (const pc of r.changes?.priceChanges ?? []) {
      const k = pc.title.toLowerCase();
      if (!priceChangeByTitle.has(k)) priceChangeByTitle.set(k, pc);
    }
  }

  const sortedMatches = [...matches].sort((a, b) => {
    const aNew = newTitles.has(titleKey(a));
    const bNew = newTitles.has(titleKey(b));
    if (aNew !== bNew) return aNew ? -1 : 1;
    return 0;
  });
  const visibleMatches = showAll ? sortedMatches : sortedMatches.slice(0, ROWS_SHOWN);
  const hiddenCount = sortedMatches.length - visibleMatches.length;

  function startEditing() {
    setEditName(monitor.name);
    setEditPrompt(monitor.prompt);
    setEditInterval(monitor.checkInterval as "5m" | "15m" | "30m" | "1h" | "6h" | "24h");
    setEditChannels((monitor.notificationChannels as Channel[]) ?? ["email"]);
    setChannelsTouched(false);
  }

  function toggleSettings() {
    if (!settingsOpen) startEditing();
    onSettingsOpenChange(!settingsOpen);
  }

  // The meta-line channel button opens settings directly (settingsOpen turns
  // true without going through toggleSettings), so hydrate the edit fields
  // here too — otherwise it shows whatever the last render left behind.
  useEffect(() => {
    if (settingsOpen) startEditing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

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
      onSettingsOpenChange(false);
      toast.success("Monitor updated");
    } catch (e) {
      toast.error("Failed to update", { description: e instanceof Error ? e.message : "" });
    } finally {
      setSaving(false);
    }
  }

  function renderDelta(item: ExtractedItem, title: string, price: string | null) {
    const pc = priceChangeByTitle.get(title.toLowerCase());
    if (pc && pc.newPrice === item.price) {
      const isDrop = pc.change < 0;
      const Icon = isDrop ? TrendingDown : TrendingUp;
      return (
        <span className={cn("text-xs inline-flex items-center gap-0.5", isDrop ? "text-emerald-400" : "text-red-400")}>
          <Icon className="h-3 w-3" />
          {Math.abs(pc.changePercent)}% <s className="text-muted-foreground">{formatPrice(pc.oldPrice, item.currency)}</s>
        </span>
      );
    }
    const origPrice = formatPrice(item.originalPrice, item.currency);
    if (origPrice && origPrice !== price) {
      return <s className="text-xs text-muted-foreground">{origPrice}</s>;
    }
    return null;
  }

  function renderEmptyCell() {
    if (totalItems > 0) {
      const next = timeUntil(monitor.nextCheckAt);
      return (
        <div className="px-4 py-8 text-center">
          <p className="text-sm font-medium">No matches yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Watching {totalItems} items, checking every {displayInterval}.
            {next && ` Next check ${next}.`}
          </p>
          <div className="mt-4 flex flex-col sm:flex-row items-center justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 w-full sm:w-auto"
              onClick={() => { trackEvent("empty_state_view_items"); onViewItems(); }}
            >
              <List className="h-3.5 w-3.5" />
              See the {totalItems} items we&apos;re watching
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 w-full sm:w-auto"
              onClick={() => { trackEvent("empty_state_adjust_filters"); onAdjustFilters(); }}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Adjust filters
            </Button>
          </div>
        </div>
      );
    }
    if (monitor.status === "scanning") {
      return (
        <div className="px-4 py-8 text-center">
          <p className="text-sm font-medium">First scan running.</p>
          <p className="mt-1 text-xs text-muted-foreground">Matches show here in about a minute.</p>
        </div>
      );
    }
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm font-medium">Nothing extracted yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          We loaded the page but found no items to compare. Check the URL points at the listing, or run the scan again.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3 gap-1.5"
          onClick={() => onRescan?.(monitorId)}
          disabled={!onRescan}
        >
          <RotateCw className="h-3.5 w-3.5" />
          Rescan
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
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
        // Parked: the scheduler stopped rescheduling this monitor after repeated
        // confirmed proxy blocks. Keyed off the count, not a cleared nextCheckAt,
        // so no other path that leaves nextCheckAt unset shows this message.
        const isParked = (monitor.proxyBlockCount ?? 0) >= MAX_PROXY_BLOCKS;
        return (
        <Card className="border-red-500/30 bg-red-500/5 shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-red-400 mb-1">
                  {isParked ? "Checks stopped" : isBlocked ? "This site blocked us" : "Monitor failed"}
                </p>
                <p className="text-sm text-muted-foreground break-words">{monitor.lastError}</p>
                <p className="text-xs text-muted-foreground/60 mt-2">
                  {isParked
                    ? "This site defeats our proxy, so we've stopped checking it automatically. Hit Retry to give it another go."
                    : isBlocked
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

      {/* Low AI confidence — only the ones the AI itself flagged as unsure */}
      {insights && insights.confidence < 50 && monitor.status !== "error" && !lowConfDismissed && (
        <Card className="border-amber-500/30 bg-amber-500/5 shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-start gap-3 flex-wrap">
              <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-amber-400 mb-1">
                  The AI wasn&apos;t sure what you meant ({insights.confidence}% confidence)
                </p>
                <p className="text-sm text-muted-foreground">
                  Check the filters it built, or reword what you&apos;re looking for in Monitor settings.
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 border-amber-500/20 hover:bg-amber-500/10"
                  onClick={() => { trackEvent("low_confidence_check_filters"); onAdjustFilters(); }}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Check filters
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Dismiss" onClick={dismissLowConfidence}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Matches */}
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              Matches
              <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
                {matches.length}
              </Badge>
            </h3>
            <span className="text-xs text-muted-foreground">of {totalItems} items</span>
          </div>
          {monitor.lastMatchAt !== undefined && (
            <span className="text-xs text-muted-foreground">Last found {timeAgo(monitor.lastMatchAt)}</span>
          )}
        </div>

        {isFirstScan && matches.length > 0 && (
          <p className="mb-2 text-xs text-emerald-400">First scan — all of these are new to you.</p>
        )}

        <div className="rounded-xl border border-border/40 bg-card/40 divide-y divide-border/40 overflow-hidden">
          {visibleMatches.length > 0 ? (
            visibleMatches.map((item, i) => {
              const key = getItemKey(item);
              const isNew = newTitles.has(titleKey(item));
              const title = String(item.title ?? item.name ?? `Item ${i + 1}`);
              const safeUrl = toSafeUrl(item.url);
              const price = formatPrice(item.price, item.currency);
              const judged = scores[key];
              const band = typeof judged?.matchScore === "number" ? MATCH_CONFIDENCE_LABEL[matchConfidence(judged.matchScore)] : "";
              const reason = judged?.matchReason ?? "";
              const delta = renderDelta(item, title, price);
              const belowThreshold = priceAlerts?.belowThreshold;
              // Only tracked items ever fire a below-threshold alert, so an
              // untracked cheap item must not wear the badge that promises one.
              const hitThreshold =
                typeof belowThreshold === "number" &&
                typeof item.price === "number" &&
                item.price <= belowThreshold &&
                (priceAlerts?.trackedItems ?? []).includes(key);

              const Row = safeUrl ? "a" : "div";
              return (
                <Row
                  key={`${key}-${i}`}
                  {...(safeUrl ? { href: safeUrl, target: "_blank", rel: "noopener noreferrer" } : {})}
                  className={cn(
                    "group grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-3",
                    "sm:grid-cols-[1fr_auto_auto] sm:gap-x-4",
                    safeUrl && "transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:bg-muted/40",
                    isNew && "bg-emerald-500/[0.06] border-l-2 border-l-emerald-400",
                  )}
                >
                  {/* col 1: title + sub-line */}
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug line-clamp-2 sm:line-clamp-1">
                      {isNew && <Badge className="mr-1.5 align-middle bg-emerald-500/15 text-emerald-400 border-emerald-500/20">New</Badge>}
                      {title}
                    </p>
                    {(band || reason) && (
                      <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1" title={reason}>
                        {band}{band && reason ? " · " : ""}{reason}
                      </p>
                    )}
                  </div>

                  {/* col 1 on mobile (second row), col 2 on sm+: price */}
                  <div className="col-start-1 sm:col-start-2 flex items-baseline gap-2 tabular-nums whitespace-nowrap">
                    {price && <span className="text-base font-semibold">{price}</span>}
                    {delta}
                    {hitThreshold && (
                      <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
                        Under {formatPrice(belowThreshold, currency)}
                      </Badge>
                    )}
                  </div>

                  {/* col 2 spanning both rows on mobile, col 3 on sm+: the open chip */}
                  {safeUrl && (
                    <span
                      className="col-start-2 row-start-1 row-span-2 sm:col-start-3 sm:row-start-auto sm:row-span-1
                        inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1
                        text-xs font-medium text-muted-foreground
                        group-hover:border-primary/50 group-hover:text-primary transition-colors"
                    >
                      Open <ExternalLink className="h-3.5 w-3.5" />
                    </span>
                  )}
                </Row>
              );
            })
          ) : (
            renderEmptyCell()
          )}
        </div>

        {hiddenCount > 0 && (
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAll(true)}>
            Show {hiddenCount} more
          </Button>
        )}
      </div>

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

      {/* Monitor settings — collapsible */}
      <div>
        <button
          onClick={toggleSettings}
          className="flex w-full items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
        >
          <Settings2 className="h-4 w-4" />
          Monitor settings
          {settingsOpen ? <ChevronUp className="h-4 w-4 ml-auto" /> : <ChevronDown className="h-4 w-4 ml-auto" />}
        </button>
        {settingsOpen && (
          <Card className="mt-4 border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardContent className="p-4 sm:p-6">
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
                  {monitor.proxyPreferred && (
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      This site blocks direct access. Anything faster than every 6
                      hours is held at 6 hours until it stops blocking us.
                    </p>
                  )}
                </div>
                <ChannelSelector value={editChannels} onChange={(c) => { setEditChannels(c); setChannelsTouched(true); }} monitorId={monitorId} />
                <div className="flex items-center gap-2 pt-2">
                  <Button size="sm" className="gap-1.5" onClick={saveEdits} disabled={saving}>
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onSettingsOpenChange(false)} disabled={saving}>
                    <X className="h-3.5 w-3.5 mr-1" /> Cancel
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* AI Insights - collapsible */}
      {schema?.insights && (
        <div>
          <button
            onClick={() => setInsightsOpen(!insightsOpen)}
            className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            {insightsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            How the AI read this page
            {(schema.insights.confidence ?? 100) < 80 && (
              <Badge variant="outline" className={`text-xs ml-1 ${
                (schema.insights.confidence ?? 0) >= 50
                  ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                  : "bg-red-500/10 text-red-400 border-red-500/20"
              }`}>
                {schema.insights.confidence}%
              </Badge>
            )}
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
