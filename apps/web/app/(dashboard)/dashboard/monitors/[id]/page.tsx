"use client";

import { use, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/prowl/status-badge";
import { AutoPauseNote } from "@/components/prowl/auto-pause-note";
import { DeleteDialog } from "@/components/prowl/delete-dialog";
import { OverviewTab } from "@/components/prowl/monitor-tabs/overview-tab";
import { ItemsTab } from "@/components/prowl/monitor-tabs/items-tab";
import { HistoryTab } from "@/components/prowl/monitor-tabs/history-tab";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowLeft,
  Play,
  Pause,
  Trash2,
  Loader2,
  LayoutDashboard,
  List,
  History,
  MoreVertical,
  Copy,
  Bell,
  BellOff,
  Clock,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMonitor, useMonitorResults, useMonitors } from "@/hooks/use-monitors";
import { useTier } from "@/hooks/use-tier";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { applyMatchConditions, getItemKey } from "@prowl/shared";
import type { Id } from "@/convex/_generated/dataModel";
import type { ExtractedItem, ExtractionSchema } from "@prowl/shared";
import { toast } from "sonner";
import { trackEvent, captureException } from "@/lib/posthog";
import { timeAgo } from "@/lib/time";

// Extended monitor type until Convex types are regenerated with npx convex dev
type MonitorExt = NonNullable<ReturnType<typeof useMonitor>> & {
  muted?: boolean;
  priceAlerts?: {
    trackedItems: string[];
    belowThreshold?: number;
    aboveThreshold?: number;
    onPriceDrop: boolean;
    onPriceIncrease: boolean;
  };
};

export default function MonitorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const monitorId = id as Id<"monitors">;
  const monitor = useMonitor(monitorId);
  const results = useMonitorResults(monitorId);
  const { monitors, togglePause, deleteMonitor, updateMonitor, toggleMute } = useMonitors();
  const { maxMonitors } = useTier();
  const atLimit = monitors.length >= maxMonitors;
  const scanBudget = useQuery(api.tiers.canScan);
  const scores = useQuery(api.monitors.latestScores, { monitorId }) ?? {};
  const consumeScan = useMutation(api.tiers.consumeScan);
  const saveScanResult = useMutation(api.monitors.saveScanResult);
  const saveScanError = useMutation(api.monitors.saveScanError);
  const createLog = useMutation(api.logs.create);
  const router = useRouter();

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [tab, setTab] = useState<"overview" | "items" | "history">("overview");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  function openSettings() {
    setTab("overview");
    setSettingsOpen(true);
  }

  async function handleToggleMute() {
    try {
      const newMuted = await toggleMute(monitorId);
      trackEvent(newMuted ? "monitor_muted" : "monitor_unmuted", { monitor_id: monitorId });
      toast.success(newMuted ? "Monitor muted — notifications paused" : "Monitor unmuted — notifications resumed");
    } catch (err) {
      captureException(err, { context: "toggleMute", monitorId });
      toast.error("Failed to update monitor", { description: err instanceof Error ? err.message : "" });
    }
  }

  async function handleRescan(id: Id<"monitors">) {
    if (!monitor) return;

    // Atomically consume a scan from the daily budget
    try {
      const result = await consumeScan();
      if (!result.success) {
        trackEvent("scan_budget_exceeded", { limit: result.limit });
        toast.error("Daily scan limit reached", {
          description: `${result.limit} scans/day on your plan. Resets at midnight UTC.`,
        });
        return;
      }
    } catch (e) {
      captureException(e, { context: "consumeScan" });
      toast.error("Failed to check scan budget");
      return;
    }

    const startTime = Date.now();

    try {
      await updateMonitor(id, { status: "scanning" as "active" });
      const res = await fetch("/api/scraper/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: monitor.url, prompt: monitor.prompt, name: monitor.name }),
      });
      const json = await res.json();
      const durationMs = Date.now() - startTime;
      if (!res.ok) throw new Error(json.message || json.error || "Failed");
      if (!json.schema || typeof json.schema !== "object") throw new Error("Invalid response from scraper");
      const matchCount = Array.isArray(json.matches) ? json.matches.length : 0;
      const totalItems = typeof json.totalItems === "number" ? json.totalItems : 0;
      await saveScanResult({ id, schema: json.schema, matchCount });
      await createLog({
        monitorId: id, monitorName: monitor.name, url: monitor.url, prompt: monitor.prompt,
        status: "success" as const, durationMs, itemCount: totalItems, matchCount,
        aiConfidence: json.schema?.insights?.confidence,
        strategy: "manual-rescan",
      }).catch((e) => captureException(e, { context: "createLog_rescan", monitorId: id }));
      toast.success("Rescan complete", { description: `${totalItems} items, ${matchCount} matches` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Rescan failed";
      const durationMs = Date.now() - startTime;
      await saveScanError({ id, error: msg }).catch((saveErr) => {
        console.error("[rescan] Failed to persist error state:", saveErr, { monitorId: id, error: msg });
      });
      const lower = msg.toLowerCase();
      const isBlocked = lower.includes("blocking") || lower.includes("anti-bot") || lower.includes("captcha") || lower.includes("blocked");
      await createLog({
        monitorId: id, monitorName: monitor.name, url: monitor.url, prompt: monitor.prompt,
        status: "error" as const, durationMs, error: msg,
        blocked: isBlocked || undefined,
        strategy: "manual-rescan",
      }).catch((e) => captureException(e, { context: "createLog_rescan_error", monitorId: id }));
      toast.error("Rescan failed", { description: msg });
    }
  }

  // Derive computed values before early returns (rules of hooks)
  const schema = monitor?.schema as ExtractionSchema | undefined;
  const allItems = (schema?.items ?? []) as ExtractedItem[];
  const blacklist = ((monitor as Record<string, unknown>)?.blacklistedItems ?? []) as string[];
  const conditions = schema?.matchConditions ?? {};
  const matchesBeforeBlacklist = allItems.length > 0 ? applyMatchConditions(allItems, conditions) : [];

  const matches = matchesBeforeBlacklist.filter(
    (item) => !blacklist.includes(getItemKey(item))
  );

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

  const m = monitor as MonitorExt;

  // Mirrors effectiveIntervalMs in convex/shared.ts — a blocked site is held
  // at 6h however often the user asked for it
  const proxyFloored =
    monitor.proxyPreferred === true &&
    ["5m", "15m", "30m", "1h"].includes(monitor.checkInterval);

  const CHANNEL_NAMES: Record<string, string> = { email: "email", push: "browser", telegram: "Telegram", discord: "Discord" };
  // An unset list means "send on every configured channel" (scheduler.ts:450),
  // not "send on none" — monitors created before the field existed have no list.
  const explicitChannels = monitor.notificationChannels;
  const channels = explicitChannels ?? [];
  const alertsOff = explicitChannels !== undefined && explicitChannels.length === 0;
  const channelNames = channels.map((c) => CHANNEL_NAMES[c] ?? c).join(", ");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 overflow-hidden">
        <Link href="/dashboard" className="shrink-0">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight truncate">{monitor.name}</h1>
            <StatusBadge status={monitor.status} />
            {m.muted && (
              <Badge variant="outline" className="gap-1 bg-amber-500/10 text-amber-400 border-amber-500/20">
                <BellOff className="h-3 w-3" />
                Muted
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed line-clamp-2" title={monitor.prompt}>
            &ldquo;{monitor.prompt}&rdquo;
          </p>
          {monitor.autoPausedAt !== undefined && (
            <div className="mt-2">
              <AutoPauseNote autoPausedAt={monitor.autoPausedAt} />
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <a
              href={monitor.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground max-w-[60vw] sm:max-w-xs"
              title={monitor.url}
            >
              <span className="truncate">{monitor.url.replace(/^https?:\/\/(www\.)?/, "")}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
            <span
              className="inline-flex items-center gap-1"
              title={
                proxyFloored
                  ? `This site only answers through our proxy, so checks run every 6 hours rather than the ${monitor.checkInterval} you picked.`
                  : undefined
              }
            >
              <Clock className="h-3 w-3" />
              every {proxyFloored ? "6h" : monitor.checkInterval}
            </span>
            <span>checked {timeAgo(monitor.lastCheckedAt)}</span>
            <span>{monitor.checkCount ?? 0} checks</span>
            {!alertsOff ? (
              <button
                type="button"
                onClick={openSettings}
                className="inline-flex items-center gap-1 hover:text-foreground"
                title="Change alert channels"
              >
                <Bell className="h-3 w-3" />
                {channels.length === 0
                  ? "alerts on"
                  : channels.length === 1
                    ? `alerts by ${channelNames}`
                    : channelNames}
              </button>
            ) : (
              <button
                type="button"
                onClick={openSettings}
                className="inline-flex items-center gap-1 text-amber-400 hover:text-amber-300"
              >
                <BellOff className="h-3 w-3" />
                no alerts
              </button>
            )}
          </div>
        </div>
        <div className="shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border/50 hover:bg-muted transition-colors">
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={async () => {
                  try {
                    await togglePause(monitorId);
                    toast.success(monitor.status === "paused" ? "Monitor resumed" : "Monitor paused");
                  } catch (err) {
                    toast.error("Failed to update monitor", { description: err instanceof Error ? err.message : "" });
                  }
                }}
              >
                {monitor.status === "paused" ? (
                  <><Play className="mr-2 h-4 w-4" /> Resume</>
                ) : (
                  <><Pause className="mr-2 h-4 w-4" /> Pause</>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleToggleMute}>
                {m.muted ? (
                  <><Bell className="mr-2 h-4 w-4" /> Unmute</>
                ) : (
                  <><BellOff className="mr-2 h-4 w-4" /> Mute</>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  if (atLimit) {
                    toast.error("Monitor limit reached", { description: "Upgrade your plan to add more monitors." });
                    return;
                  }
                  router.push(`/dashboard?clone=${monitorId}`);
                }}
              >
                <Copy className="mr-2 h-4 w-4" /> Clone
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={tab}
        onValueChange={(v) => {
          // Leaving Overview unmounts the settings form and its edit state, so
          // close it rather than reopening it blank on the way back.
          if (v !== "overview") setSettingsOpen(false);
          setTab(v as typeof tab);
        }}
      >
        <TabsList>
          <TabsTrigger value="overview">
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="items">
            <List className="mr-2 h-4 w-4" />
            Items
            {allItems.length > 0 && (
              <span className="ml-1.5 text-xs text-muted-foreground">{allItems.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history">
            <History className="mr-2 h-4 w-4" />
            History
            {results.length > 0 && (
              <span className="ml-1.5 text-xs text-muted-foreground">{results.length}</span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab
            monitorId={monitorId}
            monitor={monitor}
            matches={matches}
            allItems={allItems}
            totalItems={allItems.length}
            results={results}
            scores={scores}
            onRescan={handleRescan}
            onToggleMute={handleToggleMute}
            settingsOpen={settingsOpen}
            onSettingsOpenChange={setSettingsOpen}
            onAdjustFilters={() => { setFiltersOpen(true); setTab("items"); }}
            onViewItems={() => setTab("items")}
            displayInterval={proxyFloored ? "6h" : monitor.checkInterval}
          />
        </TabsContent>

        <TabsContent value="items" className="mt-6">
          <ItemsTab
            monitorId={monitorId}
            allItems={allItems}
            schema={schema}
            blacklist={blacklist}
            scores={scores}
            showFilters={filtersOpen}
            onShowFiltersChange={setFiltersOpen}
          />
        </TabsContent>

        <TabsContent value="history" className="mt-6">
          <HistoryTab results={results} priceAlerts={m.priceAlerts} />
        </TabsContent>
      </Tabs>

      <DeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={async () => {
          try {
            await deleteMonitor(monitorId);
            toast.success("Monitor deleted");
            router.push("/dashboard");
          } catch (err) {
            toast.error("Failed to delete", { description: err instanceof Error ? err.message : "" });
          }
        }}
        monitorName={monitor.name}
      />
    </div>
  );
}
