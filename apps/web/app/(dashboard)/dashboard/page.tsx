"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Search, Radar } from "lucide-react";
import { Input } from "@/components/ui/input";
import { MonitorCard } from "@/components/prowl/monitor-card";
import { StatsCards } from "@/components/prowl/stats-cards";
import { CreateMonitorSheet } from "@/components/prowl/create-monitor-sheet";
import { CreateMonitorDialog } from "@/components/prowl/create-monitor-dialog";
import { DeleteDialog } from "@/components/prowl/delete-dialog";
import { useMonitors } from "@/hooks/use-monitors";
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
  const { monitors, createMonitor, updateMonitor, deleteMonitor, togglePause } =
    useMonitors();

  const [createOpen, setCreateOpen] = useState(false);
  const [editMonitor, setEditMonitor] = useState<Doc<"monitors"> | null>(null);
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
        <Button onClick={() => setCreateOpen(true)} size="lg" className="gap-2 shadow-md shadow-primary/15">
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
            <SelectItem value="matched">Matched</SelectItem>
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
              <Button onClick={() => setCreateOpen(true)} className="gap-2 shadow-md shadow-primary/15">
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
              onDelete={(id) => {
                const m = monitors.find((x) => x._id === id);
                if (m) setDeleteTarget(m);
              }}
              onEdit={(m) => setEditMonitor(m)}
            />
          ))
        )}
      </div>

      <CreateMonitorSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(data) => {
          createMonitor(data);
          toast.success("Monitor created", {
            description: `Now watching ${new URL(data.url).hostname}`,
          });
        }}
      />

      <CreateMonitorDialog
        open={!!editMonitor}
        onOpenChange={(open) => !open && setEditMonitor(null)}
        editMonitor={editMonitor}
        onSubmit={(data) => {
          if (editMonitor) {
            updateMonitor(editMonitor._id, data);
            toast.success("Monitor updated");
            setEditMonitor(null);
          }
        }}
      />

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
