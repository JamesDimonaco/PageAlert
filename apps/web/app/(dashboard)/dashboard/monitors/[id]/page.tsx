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
  ArrowLeft,
  Play,
  Pause,
  Trash2,
  Loader2,
  LayoutDashboard,
  List,
  History,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMonitor, useMonitorResults, useMonitors } from "@/hooks/use-monitors";
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
  const { togglePause, deleteMonitor } = useMonitors();
  const router = useRouter();

  const [deleteOpen, setDeleteOpen] = useState(false);

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
