"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Search, Radar } from "lucide-react";
import { Input } from "@/components/ui/input";
import { MonitorCard } from "@/components/prowl/monitor-card";
import { StatsCards } from "@/components/prowl/stats-cards";
import { DeleteDialog } from "@/components/prowl/delete-dialog";
import { useMonitors } from "@/hooks/use-monitors";
import { useCreateMonitor } from "@/hooks/use-create-monitor";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import { trackMonitorDeleted, trackMonitorPaused, trackMonitorResumed, setUserProperties } from "@/lib/posthog";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function DashboardPage() {
  const { monitors, togglePause, deleteMonitor, updateMonitor } = useMonitors();
  const { open: openCreate } = useCreateMonitor();
  const saveScanResult = useMutation(api.monitors.saveScanResult);
  const saveScanError = useMutation(api.monitors.saveScanError);
  const createLog = useMutation(api.logs.create);

  // Sync monitor count to PostHog for cohort analysis
  useEffect(() => {
    if (monitors.length >= 0) {
      setUserProperties({
        monitor_count: monitors.length,
        active_monitors: monitors.filter((m) => m.status === "active").length,
      });
    }
  }, [monitors.length]);

  async function handleRescan(monitorId: Id<"monitors">) {
    const monitor = monitors.find((m) => m._id === monitorId);
    if (!monitor) return;

    const startTime = Date.now();

    try {
      // Set status to scanning so the badge updates immediately
      await updateMonitor(monitorId, { status: "scanning" as "active" }); // "scanning" in Convex schema, types regenerate with npx convex dev

      const res = await fetch("/api/scraper/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: monitor.url, prompt: monitor.prompt, name: monitor.name }),
      });
      const json = await res.json();
      const durationMs = Date.now() - startTime;

      if (!res.ok) throw new Error(json.error || json.message || "Failed");

      const matchCount = json.matches?.length ?? 0;
      const totalItems = json.totalItems ?? 0;
      const insights = json.schema?.insights;
      const confidence = insights?.confidence ?? 100;

      // Page inaccessible check
      if (confidence <= 10 && totalItems === 0) {
        const reason = insights?.notices?.[0] ?? "Page appears inaccessible";
        await saveScanError({ id: monitorId, error: reason });
        await createLog({
          monitorId, monitorName: monitor.name, url: monitor.url, prompt: monitor.prompt,
          status: "error" as const, durationMs, error: reason,
          rawResponse: JSON.stringify(json).slice(0, 50000),
          aiConfidence: confidence, aiUnderstanding: insights?.understanding, aiNotices: insights?.notices,
        });
        toast.error("Page inaccessible", { description: reason });
        return;
      }

      await saveScanResult({ id: monitorId, schema: json.schema, matchCount });
      await createLog({
        monitorId, monitorName: monitor.name, url: monitor.url, prompt: monitor.prompt,
        status: "success" as const, durationMs, itemCount: totalItems, matchCount,
        rawResponse: JSON.stringify(json).slice(0, 50000),
        aiConfidence: insights?.confidence, aiUnderstanding: insights?.understanding,
        aiMatchSignal: insights?.matchSignal, aiNoMatchSignal: insights?.noMatchSignal,
        aiNotices: insights?.notices, matchConditions: json.schema?.matchConditions,
      }).catch(() => {});
      toast.success("Rescan complete", {
        description: `${totalItems} items, ${matchCount} matches`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Rescan failed";
      const durationMs = Date.now() - startTime;
      await saveScanError({ id: monitorId, error: msg }).catch(() => {});
      await createLog({
        monitorId,
        monitorName: monitor.name,
        url: monitor.url,
        prompt: monitor.prompt,
        status: "error" as const,
        durationMs,
        error: msg,
      }).catch(() => {});
      toast.error("Rescan failed", { description: msg });
    }
  }

  const [deleteTarget, setDeleteTarget] = useState<Doc<"monitors"> | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const filtered = monitors.filter((m) => {
    const matchesSearch =
      !search ||
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.url.toLowerCase().includes(search.toLowerCase()) ||
      m.prompt.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || m.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-10">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1 sm:mt-2 text-sm leading-relaxed">
            Monitor any website with natural language
          </p>
        </div>
        <Button onClick={openCreate} size="lg" className="gap-2 shadow-md shadow-primary/15 w-full sm:w-auto">
          <Plus className="h-5 w-5" />
          New Monitor
        </Button>
      </div>

      <StatsCards monitors={monitors} />

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search monitors..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v)}>
          <SelectTrigger className="w-full sm:w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="scanning">Scanning</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-4">
        {filtered.length === 0 ? (
          monitors.length === 0 ? (
            <div className="rounded-xl bg-card/30 shadow-sm shadow-black/5 py-16 px-8">
              <div className="max-w-lg mx-auto text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/5 mx-auto mb-6">
                  <Radar className="h-7 w-7 text-primary/60" />
                </div>
                <h2 className="text-xl font-bold mb-2">Welcome to PageAlert</h2>
                <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
                  Monitor any website with AI. Just paste a URL and describe what you&apos;re looking for.
                </p>

                <Button onClick={openCreate} size="lg" className="gap-2 shadow-md shadow-primary/15 mb-10">
                  <Plus className="h-5 w-5" />
                  Create Your First Monitor
                </Button>

                <div className="text-left space-y-4">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Ideas to get started</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {[
                      { title: "Track a price drop", desc: "\"MacBook Pro under $1500\"" },
                      { title: "Restock alert", desc: "\"PS5 console in stock\"" },
                      { title: "New listings", desc: "\"3 bed house under 400k in Bristol\"" },
                      { title: "Job monitoring", desc: "\"Senior React developer remote\"" },
                    ].map((example) => (
                      <div key={example.title} className="rounded-lg bg-background/50 border border-border/20 p-3 text-left">
                        <p className="text-sm font-medium">{example.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 italic">{example.desc}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-xl bg-card/30 shadow-sm shadow-black/5 py-20 px-8">
              <Search className="h-7 w-7 text-muted-foreground/60 mb-4" />
              <p className="text-lg font-semibold mb-2">No monitors found</p>
              <p className="text-sm text-muted-foreground max-w-sm text-center leading-relaxed">
                Try adjusting your search or filters.
              </p>
            </div>
          )
        ) : (
          filtered.map((monitor) => (
            <MonitorCard
              key={monitor._id}
              monitor={monitor}
              onTogglePause={async (id) => {
                const m = monitors.find((x) => x._id === id);
                try {
                  await togglePause(id);
                  if (m?.status === "paused") {
                    trackMonitorResumed();
                    toast.success("Monitor resumed");
                  } else {
                    trackMonitorPaused();
                    toast.success("Monitor paused");
                  }
                } catch {
                  toast.error("Failed to update monitor");
                }
              }}
              onRescan={handleRescan}
              onDelete={(id) => {
                const m = monitors.find((x) => x._id === id);
                if (m) setDeleteTarget(m);
              }}
            />
          ))
        )}
      </div>

      <DeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            deleteMonitor(deleteTarget._id);
            trackMonitorDeleted();
            toast.success("Monitor deleted");
            setDeleteTarget(null);
          }
        }}
        monitorName={deleteTarget?.name ?? ""}
      />
    </div>
  );
}
