"use client";

import { useState, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ExternalLink,
  AlertTriangle,
  Search,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import Link from "next/link";
import { timeAgo } from "@/lib/time";
import { formatStrategy } from "@/lib/strategy";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const statusConfig = {
  success: { icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-500/10", label: "Success" },
  error: { icon: XCircle, color: "text-red-400", bg: "bg-red-500/10", label: "Error" },
  timeout: { icon: AlertTriangle, color: "text-amber-400", bg: "bg-amber-500/10", label: "Timeout" },
};

const PAGE_SIZE = 25;

export default function LogsPage() {
  const logs = useQuery(api.logs.list, { limit: 500 });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [monitorFilter, setMonitorFilter] = useState<string>("all");
  const [groupBy, setGroupBy] = useState<"none" | "monitor">("none");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Derive unique monitors for the filter dropdown (keyed by stable monitorId)
  const monitors = useMemo(() => {
    if (!logs) return [];
    const seen = new Map<string, string>();
    for (const log of logs) {
      const key = log.monitorId ?? log.url;
      const label = log.monitorName ?? log.url;
      if (!seen.has(key)) seen.set(key, label);
    }
    return Array.from(seen.entries())
      .sort(([, a], [, b]) => a.localeCompare(b));
  }, [logs]);

  // Apply filters
  const filtered = useMemo(() => {
    if (!logs) return [];
    return logs.filter((log) => {
      if (statusFilter !== "all" && log.status !== statusFilter) return false;
      if (monitorFilter !== "all" && (log.monitorId ?? log.url) !== monitorFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const matches =
          log.url.toLowerCase().includes(q) ||
          (log.monitorName ?? "").toLowerCase().includes(q) ||
          (log.error ?? "").toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    });
  }, [logs, statusFilter, monitorFilter, search]);

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Build a label lookup from stable key → display name
  const monitorLabels = useMemo(() => {
    const map = new Map<string, string>();
    if (logs) {
      for (const log of logs) {
        const key = log.monitorId ?? log.url;
        if (!map.has(key)) map.set(key, log.monitorName ?? log.url);
      }
    }
    return map;
  }, [logs]);

  // Group logs by monitor (keyed by monitorId)
  const grouped = useMemo(() => {
    if (groupBy !== "monitor") return null;
    const map = new Map<string, typeof filtered>();
    for (const log of filtered) {
      const key = log.monitorId ?? log.url;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(log);
    }
    return Array.from(map.entries()).sort(([, a], [, b]) => b[0].createdAt - a[0].createdAt);
  }, [filtered, groupBy]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Scrape Logs</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          Debug log of all scrape attempts with raw AI responses
        </p>
      </div>

      {/* Summary bar */}
      {logs && logs.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{logs.length} total</span>
          <span className="text-emerald-400">{logs.filter((l) => l.status === "success").length} success</span>
          <span className="text-red-400">{logs.filter((l) => l.status === "error").length} errors</span>
          {logs.some((l) => l.status === "timeout") && (
            <span className="text-amber-400">{logs.filter((l) => l.status === "timeout").length} timeouts</span>
          )}
          {logs.some((l) => (l as any).blocked) && (
            <span className="text-red-400">{logs.filter((l) => (l as any).blocked).length} blocked</span>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="relative flex-1 sm:max-w-sm">
          <label className="text-xs text-muted-foreground mb-1 block">Search</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search URL, monitor, or error..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
              className="pl-9"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Status</label>
          <Select value={statusFilter} onValueChange={(v) => { if (v) { setStatusFilter(v); setVisibleCount(PAGE_SIZE); } }}>
            <SelectTrigger className="w-full sm:w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="timeout">Timeout</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {monitors.length > 1 && (
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Monitor</label>
            <Select value={monitorFilter} onValueChange={(v) => { if (v) { setMonitorFilter(v); setVisibleCount(PAGE_SIZE); } }}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All monitors</SelectItem>
                {monitors.map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    <span className="truncate max-w-[140px] block">{label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {monitors.length > 1 && (
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Group by</label>
            <Select value={groupBy} onValueChange={(v) => setGroupBy(v as "none" | "monitor")}>
              <SelectTrigger className="w-full sm:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No grouping</SelectItem>
                <SelectItem value="monitor">By monitor</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {logs === undefined ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl bg-card/30 py-20">
          <Clock className="h-8 w-8 text-muted-foreground mb-4" />
          <p className="text-sm text-muted-foreground">No scrape logs yet</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl bg-card/30 py-20">
          <Search className="h-7 w-7 text-muted-foreground/60 mb-4" />
          <p className="text-lg font-semibold mb-2">No logs found</p>
          <p className="text-sm text-muted-foreground">Try adjusting your search or filters.</p>
        </div>
      ) : grouped ? (
        // Grouped view
        <div className="space-y-4">
          {grouped.map(([groupKey, groupLogs]) => {
            const isCollapsed = collapsedGroups.has(groupKey);
            const label = monitorLabels.get(groupKey) ?? groupKey;
            const successCount = groupLogs.filter((l) => l.status === "success").length;
            const errorCount = groupLogs.filter((l) => l.status !== "success").length;
            return (
              <div key={groupKey} className="rounded-xl border border-border/30 bg-card/30 overflow-hidden">
                <button
                  onClick={() => toggleGroup(groupKey)}
                  className="w-full flex items-center justify-between p-4 hover:bg-card/50 transition-colors text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {isCollapsed ? (
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <span className="text-sm font-semibold truncate">{label}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                    <span>{groupLogs.length} log{groupLogs.length !== 1 ? "s" : ""}</span>
                    {successCount > 0 && <span className="text-emerald-400">{successCount} ok</span>}
                    {errorCount > 0 && <span className="text-red-400">{errorCount} failed</span>}
                  </div>
                </button>
                {!isCollapsed && (
                  <div className="border-t border-border/20 space-y-1 p-2">
                    {groupLogs.map((log) => (
                      <LogEntry key={log._id} log={log} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        // Flat view with pagination
        <div className="space-y-3">
          {filtered.slice(0, visibleCount).map((log) => (
            <LogEntry key={log._id} log={log} />
          ))}
          {visibleCount < filtered.length && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                className="gap-2"
              >
                Show more ({filtered.length - visibleCount} remaining)
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Summary */}
      {logs && logs.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {grouped ? filtered.length : Math.min(visibleCount, filtered.length)} of {filtered.length} logs
          {filtered.length !== logs.length && ` (filtered from ${logs.length})`}
        </p>
      )}
    </div>
  );
}

interface Log {
  _id: string;
  url: string;
  status: "success" | "error" | "timeout";
  createdAt: number;
  durationMs: number;
  monitorId?: string;
  monitorName?: string;
  itemCount?: number;
  matchCount?: number;
  error?: string;
  aiConfidence?: number;
  strategy?: string;
  blocked?: boolean;
  blockReason?: string;
  retryAttempt?: number;
}

function LogEntry({ log }: { log: Log }) {
  const config = statusConfig[log.status];
  const Icon = config.icon;
  const strat = formatStrategy((log as any).strategy);

  return (
    <Link href={`/dashboard/logs/${log._id}`}>
      <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5 hover:bg-card/80 transition-colors cursor-pointer">
        <CardContent className="p-4 sm:p-5">
          <div className="flex items-start sm:items-center justify-between gap-3">
            <div className="flex items-start sm:items-center gap-3 sm:gap-4 min-w-0">
              <div className={`flex h-9 w-9 items-center justify-center rounded-full ${config.bg} shrink-0`}>
                <Icon className={`h-4 w-4 ${config.color}`} />
              </div>
              <div className="min-w-0">
                {log.monitorName && (
                  <p className="text-xs font-semibold text-primary mb-0.5 truncate">{log.monitorName}</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-muted-foreground truncate max-w-[200px] sm:max-w-md">
                    {log.url}
                  </p>
                  <Badge
                    variant="outline"
                    className={`text-[10px] ${
                      log.status === "success"
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                        : log.status === "timeout"
                          ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                          : "bg-red-500/10 text-red-400 border-red-500/20"
                    }`}
                  >
                    {config.label}
                  </Badge>
                  <Badge variant="outline" className={`text-[10px] ${strat.color}`}>
                    {strat.label}
                  </Badge>
                  {(log as any).blocked && (
                    <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-[10px]">
                      Blocked
                    </Badge>
                  )}
                  {(log as any).retryAttempt != null && (log as any).retryAttempt > 0 && (
                    <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-400 border-amber-500/20">
                      Retry {(log as any).retryAttempt}/3
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-xs text-muted-foreground">
                  <span>{timeAgo(log.createdAt)}</span>
                  <span>{formatDuration(log.durationMs)}</span>
                  {log.itemCount != null && <span>{log.itemCount} items</span>}
                  {log.matchCount != null && <span>{log.matchCount} match{log.matchCount !== 1 ? "es" : ""}</span>}
                  {log.error && (
                    <span className="text-red-400 truncate max-w-xs">{log.error}</span>
                  )}
                </div>
              </div>
            </div>
            <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
