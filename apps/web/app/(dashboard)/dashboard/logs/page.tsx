"use client";

import { useState, useMemo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
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
  Ban,
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

/**
 * How many logs to ask for. The server clamps this to its own ceiling (see
 * MAX_LIST_LIMIT in convex/logs.ts, bounded by how big one row can get), so
 * treat it as a request and read the actual count off the result.
 */
const FETCH_LIMIT = 150;

type StatusFilter = "all" | "success" | "error" | "timeout" | "blocked";

export default function LogsPage() {
  const data = useQuery(api.logs.list, { limit: FETCH_LIMIT });
  const logs = data?.logs;
  // Convex's own auth state, not Better Auth's. A null window means the query
  // saw no identity, which is normal while this is still settling and
  // terminal once it has — without the second half the page spins forever on
  // the split where Better Auth is signed in and the Convex socket is not.
  const { isLoading: convexAuthLoading } = useConvexAuth();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [monitorFilter, setMonitorFilter] = useState<string>("all");
  const [groupBy, setGroupBy] = useState<"none" | "monitor">("none");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  function resetPaging() {
    setVisibleCount(PAGE_SIZE);
  }

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

  const counts = useMemo(() => {
    const tally = { success: 0, error: 0, timeout: 0, blocked: 0 };
    for (const log of logs ?? []) {
      tally[log.status]++;
      if (log.blocked) tally.blocked++;
    }
    return tally;
  }, [logs]);

  // Apply filters
  const filtered = useMemo(() => {
    if (!logs) return [];
    return logs.filter((log) => {
      if (statusFilter === "blocked") {
        if (!log.blocked) return false;
      } else if (statusFilter !== "all" && log.status !== statusFilter) {
        return false;
      }
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

  // Group logs by monitor (keyed by monitorId), newest group first. Sorting on
  // each group's newest log rather than its first element, so the order holds
  // even if the query ever stops arriving newest-first.
  const grouped = useMemo(() => {
    if (groupBy !== "monitor") return null;
    const map = new Map<string, typeof filtered>();
    for (const log of filtered) {
      const key = log.monitorId ?? log.url;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(log);
    }
    return Array.from(map.entries()).sort(
      ([, a], [, b]) =>
        Math.max(...b.map((l) => l.createdAt)) - Math.max(...a.map((l) => l.createdAt))
    );
  }, [filtered, groupBy]);

  const windowDays = data?.windowDays;
  const isFiltered = filtered.length !== (logs?.length ?? 0);
  // Every count on this page is of the rows we fetched. When that is a slice
  // of the window, each one is a floor — say so on all of them, not just the
  // total, or "12 errors" reads as the whole week's errors.
  const atLeast = data?.capped ? "+" : "";
  // Groups hold their own page size. Remounting them when the filters change
  // keeps the two views paging alike — otherwise a group expanded to 50 rows
  // stays at 50 while the flat view snaps back to 25.
  const filterKey = `${statusFilter}|${monitorFilter}|${search}`;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Scrape Logs</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          Every check we ran for you, with what the AI made of the page.
          {windowDays != null && ` Your plan shows the last ${windowDays} days.`}
        </p>
      </div>

      {/* Summary bar — doubles as the status filter, since the counts are
          already here and clicking a number is what people try first. */}
      {logs && logs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <StatChip
            label={`${logs.length}${atLeast} check${logs.length === 1 ? "" : "s"}`}
            active={statusFilter === "all"}
            onClick={() => { setStatusFilter("all"); resetPaging(); }}
          />
          <StatChip
            label={`${counts.success}${atLeast} ok`}
            tone="text-emerald-400"
            active={statusFilter === "success"}
            onClick={() => { setStatusFilter("success"); resetPaging(); }}
          />
          {counts.error > 0 && (
            <StatChip
              label={`${counts.error}${atLeast} error${counts.error === 1 ? "" : "s"}`}
              tone="text-red-400"
              active={statusFilter === "error"}
              onClick={() => { setStatusFilter("error"); resetPaging(); }}
            />
          )}
          {counts.timeout > 0 && (
            <StatChip
              label={`${counts.timeout}${atLeast} timeout${counts.timeout === 1 ? "" : "s"}`}
              tone="text-amber-400"
              active={statusFilter === "timeout"}
              onClick={() => { setStatusFilter("timeout"); resetPaging(); }}
            />
          )}
          {counts.blocked > 0 && (
            <StatChip
              label={`${counts.blocked}${atLeast} blocked`}
              tone="text-red-400"
              icon={Ban}
              active={statusFilter === "blocked"}
              onClick={() => { setStatusFilter("blocked"); resetPaging(); }}
            />
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="relative flex-1 sm:max-w-sm">
          <label htmlFor="log-search" className="text-xs text-muted-foreground mb-1 block">Search</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="log-search"
              placeholder="Search URL, monitor, or error..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); resetPaging(); }}
              className="pl-9"
            />
          </div>
        </div>
        <div>
          <label htmlFor="log-status" className="text-xs text-muted-foreground mb-1 block">Status</label>
          <Select value={statusFilter} onValueChange={(v) => { if (v) { setStatusFilter(v as StatusFilter); resetPaging(); } }}>
            <SelectTrigger id="log-status" className="w-full sm:w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="timeout">Timeout</SelectItem>
              <SelectItem value="blocked">Blocked</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {monitors.length > 1 && (
          <div>
            <label htmlFor="log-monitor" className="text-xs text-muted-foreground mb-1 block">Monitor</label>
            <Select value={monitorFilter} onValueChange={(v) => { if (v) { setMonitorFilter(v); resetPaging(); } }}>
              <SelectTrigger id="log-monitor" className="w-full sm:w-[180px]">
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
            <label htmlFor="log-groupby" className="text-xs text-muted-foreground mb-1 block">Group by</label>
            <Select value={groupBy} onValueChange={(v) => { setGroupBy(v as "none" | "monitor"); resetPaging(); }}>
              <SelectTrigger id="log-groupby" className="w-full sm:w-[150px]">
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

      {/* windowDays is null until Convex has the identity, so an empty result
          here is "not looked yet" — but only while that is still resolving. */}
      {logs === undefined || (windowDays == null && convexAuthLoading) ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl bg-card/30 py-20 px-6 text-center">
          <Clock className="h-8 w-8 text-muted-foreground mb-4" />
          <p className="text-sm font-medium mb-1">No checks to show</p>
          {/* Says what the page covers without claiming there is anything
              behind it — a new account and a downgraded one both land here. */}
          {windowDays != null && (
            <p className="text-xs text-muted-foreground">
              This page shows your last {windowDays} days.
            </p>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl bg-card/30 py-20">
          <Search className="h-7 w-7 text-muted-foreground/60 mb-4" />
          <p className="text-lg font-semibold mb-2">No logs found</p>
          <p className="text-sm text-muted-foreground">Try adjusting your search or filters.</p>
        </div>
      ) : grouped ? (
        // Grouped view. Each group pages independently — one busy monitor used
        // to render every one of its logs the moment the group opened.
        <div className="space-y-4">
          {grouped.map(([groupKey, groupLogs]) => (
            <MonitorGroup
              key={`${groupKey}|${filterKey}`}
              label={monitorLabels.get(groupKey) ?? groupKey}
              logs={groupLogs}
              collapsed={collapsedGroups.has(groupKey)}
              onToggle={() => toggleGroup(groupKey)}
            />
          ))}
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

      {/* What you are looking at, said exactly. The old line called the loaded
          slice the total, which read as data loss once the cap bit. Grouped
          view counts monitors rather than rows, because each group pages on
          its own and no single number describes what is on screen. */}
      {logs && logs.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          {grouped
            ? `${filtered.length} log${filtered.length === 1 ? "" : "s"} across ${grouped.length} monitor${grouped.length === 1 ? "" : "s"}`
            : `Showing ${Math.min(visibleCount, filtered.length)} of ${filtered.length}`}
          {isFiltered && `, filtered from ${logs.length}`}
          {data?.capped
            ? ` — the ${logs.length} most recent of your last ${windowDays} days`
            /* "every check" only reads true of an unfiltered view; next to a
               filter clause it would contradict the sentence it ends. */
            : !isFiltered && ` — every check in your last ${windowDays} days`}
        </p>
      )}
    </div>
  );
}

function StatChip({
  label,
  tone,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  tone?: string;
  icon?: typeof Ban;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
        active
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border/30 bg-card/30 text-muted-foreground hover:bg-card/60"
      }`}
    >
      {Icon && <Icon className="h-3 w-3" />}
      <span className={active ? undefined : tone}>{label}</span>
    </button>
  );
}

const GROUP_PAGE_SIZE = 10;

function MonitorGroup({
  label,
  logs,
  collapsed,
  onToggle,
}: {
  label: string;
  logs: Log[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [shown, setShown] = useState(GROUP_PAGE_SIZE);
  const successCount = logs.filter((l) => l.status === "success").length;
  const errorCount = logs.length - successCount;

  return (
    <div className="rounded-xl border border-border/30 bg-card/30 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 hover:bg-card/50 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
          <span className="text-sm font-semibold truncate">{label}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
          <span>{logs.length} log{logs.length !== 1 ? "s" : ""}</span>
          {successCount > 0 && <span className="text-emerald-400">{successCount} ok</span>}
          {errorCount > 0 && <span className="text-red-400">{errorCount} failed</span>}
        </div>
      </button>
      {!collapsed && (
        <div className="border-t border-border/20 space-y-1 p-2">
          {logs.slice(0, shown).map((log) => (
            <LogEntry key={log._id} log={log} />
          ))}
          {shown < logs.length && (
            <div className="flex justify-center py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShown((c) => c + GROUP_PAGE_SIZE)}
              >
                Show {Math.min(GROUP_PAGE_SIZE, logs.length - shown)} more
              </Button>
            </div>
          )}
        </div>
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
  strategy?: string;
  blocked?: boolean;
  retryAttempt?: number;
}

function LogEntry({ log }: { log: Log }) {
  const config = statusConfig[log.status];
  const Icon = config.icon;
  const strat = formatStrategy(log.strategy);

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
                  {log.blocked && (
                    <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-[10px]">
                      Blocked
                    </Badge>
                  )}
                  {log.retryAttempt != null && log.retryAttempt > 0 && (
                    <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-400 border-amber-500/20">
                      Retry {log.retryAttempt}/3
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
