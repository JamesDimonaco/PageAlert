"use client";

import { use, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/prowl/status-badge";
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
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMonitor, useMonitorResults, useMonitors } from "@/hooks/use-monitors";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { applyMatchConditions, getItemKey } from "@prowl/shared";
import type { Id } from "@/convex/_generated/dataModel";
import type { ExtractedItem, ExtractionSchema } from "@prowl/shared";
import { toast } from "sonner";

export default function MonitorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const monitorId = id as Id<"monitors">;
  const monitor = useMonitor(monitorId);
  const results = useMonitorResults(monitorId);
  const { togglePause, deleteMonitor, updateMonitor } = useMonitors();
  const saveScanResult = useMutation(api.monitors.saveScanResult);
  const saveScanError = useMutation(api.monitors.saveScanError);
  const router = useRouter();

  const [deleteOpen, setDeleteOpen] = useState(false);

  async function handleRescan(id: Id<"monitors">) {
    if (!monitor) return;
    try {
      await updateMonitor(id, { status: "scanning" as "active" });
      const res = await fetch("/api/scraper/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: monitor.url, prompt: monitor.prompt, name: monitor.name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || json.message || "Failed");
      if (!json.schema || typeof json.schema !== "object") throw new Error("Invalid response from scraper");
      const matchCount = Array.isArray(json.matches) ? json.matches.length : 0;
      const totalItems = typeof json.totalItems === "number" ? json.totalItems : 0;
      await saveScanResult({ id, schema: json.schema, matchCount });
      toast.success("Rescan complete", { description: `${totalItems} items, ${matchCount} matches` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Rescan failed";
      await saveScanError({ id, error: msg }).catch((saveErr) => {
        console.error("[rescan] Failed to persist error state:", saveErr, { monitorId: id, error: msg });
      });
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

  return (
    <div className="space-y-8">
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
          </div>
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
            &ldquo;{monitor.prompt}&rdquo;
          </p>
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
              <DropdownMenuItem
                onClick={() => {
                  // Clone — open create sheet with this monitor's data
                  const params = new URLSearchParams({
                    clone: monitorId,
                    name: `${monitor.name} (copy)`,
                    url: monitor.url,
                    prompt: monitor.prompt,
                  });
                  router.push(`/dashboard?${params.toString()}`);
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
      <Tabs defaultValue="overview">
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
            totalItems={allItems.length}
            onRescan={handleRescan}
          />
        </TabsContent>

        <TabsContent value="items" className="mt-6">
          <ItemsTab
            monitorId={monitorId}
            allItems={allItems}
            schema={schema}
            blacklist={blacklist}
          />
        </TabsContent>

        <TabsContent value="history" className="mt-6">
          <HistoryTab results={results} />
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
