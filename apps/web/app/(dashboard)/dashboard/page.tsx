"use client";

import { useState } from "react";
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

  async function handleRescan(monitorId: Id<"monitors">) {
    const monitor = monitors.find((m) => m._id === monitorId);
    if (!monitor) return;

    // Set status to scanning so the badge updates immediately
    await updateMonitor(monitorId, { status: "scanning" });
    const startTime = Date.now();

    try {
      const res = await fetch("/api/scraper/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: monitor.url, prompt: monitor.prompt }),
      });
      const json = await res.json();
      const durationMs = Date.now() - startTime;

      if (!res.ok) throw new Error(json.error || json.message || "Failed");

      const matchCount = json.matches?.length ?? 0;
      await saveScanResult({ id: monitorId, schema: json.schema, matchCount });
      await createLog({
        monitorId,
        url: monitor.url,
        prompt: monitor.prompt,
        status: "success" as const,
        durationMs,
        itemCount: json.totalItems,
        matchCount,
        rawResponse: JSON.stringify(json).slice(0, 50000),
      });
      toast.success("Rescan complete", {
        description: `${json.totalItems} items, ${matchCount} matches`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Rescan failed";
      const durationMs = Date.now() - startTime;
      await saveScanError({ id: monitorId, error: msg }).catch(() => {});
      await createLog({
        monitorId,
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            Monitor any website with natural language
          </p>
        </div>
        <Button onClick={openCreate} size="lg" className="gap-2 shadow-md shadow-primary/15">
          <Plus className="h-5 w-5" />
          New Monitor
        </Button>
      </div>

      <StatsCards monitors={monitors} />

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search monitors..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v)}>
          <SelectTrigger className="w-[150px]">
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
          <div className="flex flex-col items-center justify-center rounded-xl bg-card/30 shadow-sm shadow-black/5 py-20 px-8">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/5 mb-6">
              {monitors.length === 0 ? (
                <Radar className="h-7 w-7 text-primary/60" />
              ) : (
                <Search className="h-7 w-7 text-muted-foreground/60" />
              )}
            </div>
            <p className="text-lg font-semibold mb-2">
              {monitors.length === 0 ? "Start monitoring the web" : "No monitors found"}
            </p>
            <p className="text-sm text-muted-foreground mb-6 max-w-sm text-center leading-relaxed">
              {monitors.length === 0
                ? "Create your first monitor to track changes on any website using natural language."
                : "Try adjusting your search or filters to find what you're looking for."}
            </p>
            {monitors.length === 0 && (
              <Button onClick={openCreate} className="gap-2 shadow-md shadow-primary/15">
                <Plus className="h-4 w-4" />
                Create Your First Monitor
              </Button>
            )}
          </div>
        ) : (
          filtered.map((monitor) => (
            <MonitorCard
              key={monitor._id}
              monitor={monitor}
              onTogglePause={(id) => {
                togglePause(id);
                const m = monitors.find((x) => x._id === id);
                toast.success(
                  m?.status === "paused" ? "Monitor resumed" : "Monitor paused"
                );
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
            toast.success("Monitor deleted");
            setDeleteTarget(null);
          }
        }}
        monitorName={deleteTarget?.name ?? ""}
      />
    </div>
  );
}
