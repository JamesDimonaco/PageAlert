"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  TrendingDown,
  TrendingUp,
  Plus,
  Minus,
  History,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";
import { timeAgo } from "@/lib/time";

interface HistoryTabProps {
  results: Doc<"scrapeResults">[];
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

type FilterType = "all" | "matches" | "changes" | "errors";

export function HistoryTab({ results }: HistoryTabProps) {
  const [filter, setFilter] = useState<FilterType>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = results.filter((r) => {
    if (filter === "all") return true;
    if (filter === "matches") return r.hasNewMatches;
    if (filter === "changes") return r.changes && r.changes.summary !== "No changes";
    if (filter === "errors") return !!r.error;
    return true;
  });

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <History className="h-8 w-8 text-muted-foreground/40 mb-4" />
        <p className="text-sm text-muted-foreground">No history yet</p>
        <p className="text-xs text-muted-foreground/70 mt-1">Check results will appear here as the scheduler runs</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{filtered.length} of {results.length} events</p>
        <Select value={filter} onValueChange={(v) => v && setFilter(v as FilterType)}>
          <SelectTrigger className="w-[150px] h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All events</SelectItem>
            <SelectItem value="matches">Matches only</SelectItem>
            <SelectItem value="changes">Changes only</SelectItem>
            <SelectItem value="errors">Errors only</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Timeline */}
      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-[18px] top-0 bottom-0 w-px bg-border/50" />

        <div className="space-y-3">
          {filtered.map((result, index) => {
            const isExpanded = expandedId === result._id;
            const hasChanges = result.changes && result.changes.summary !== "No changes";

            return (
              <div key={result._id} className="relative pl-10">
                {/* Timeline dot */}
                <div className="absolute left-0 top-4">
                  <div className={`h-9 w-9 rounded-full flex items-center justify-center ${
                    result.error
                      ? "bg-red-500/10"
                      : result.hasNewMatches
                        ? "bg-emerald-500/10"
                        : hasChanges
                          ? "bg-blue-500/10"
                          : "bg-muted/50"
                  }`}>
                    {result.error ? (
                      <XCircle className="h-4 w-4 text-red-400" />
                    ) : result.hasNewMatches ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    ) : hasChanges ? (
                      <TrendingDown className="h-4 w-4 text-blue-400" />
                    ) : (
                      <Clock className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                </div>

                <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
                  <CardContent className="p-4">
                    {/* Header */}
                    <button
                      className="w-full text-left"
                      onClick={() => setExpandedId(isExpanded ? null : result._id)}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            {/* Latest badge */}
                            {index === 0 && (
                              <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/20">
                                Latest
                              </Badge>
                            )}
                            <p className="text-sm font-medium">
                              {result.error
                                ? "Check failed"
                                : result.hasNewMatches
                                  ? `${result.matches.length} match${result.matches.length !== 1 ? "es" : ""} found`
                                  : result.totalItems > 0
                                    ? `${result.totalItems} items scanned`
                                    : "No data"}
                            </p>
                            {/* Change badges */}
                            {hasChanges && result.changes!.added.length > 0 && (
                              <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-400 border-emerald-500/20 gap-1">
                                <Plus className="h-3 w-3" />
                                {result.changes!.added.length} new
                              </Badge>
                            )}
                            {hasChanges && result.changes!.removed.length > 0 && (
                              <Badge variant="outline" className="text-xs bg-red-500/10 text-red-400 border-red-500/20 gap-1">
                                <Minus className="h-3 w-3" />
                                {result.changes!.removed.length} gone
                              </Badge>
                            )}
                            {hasChanges && result.changes!.priceChanges.length > 0 && (
                              <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-400 border-blue-500/20 gap-1">
                                {result.changes!.priceChanges.some((p) => p.change < 0)
                                  ? <><TrendingDown className="h-3 w-3" /> Price drops</>
                                  : <><TrendingUp className="h-3 w-3" /> Price changes</>
                                }
                              </Badge>
                            )}
                            {result.error && (
                              <Badge variant="outline" className="text-xs bg-red-500/10 text-red-400 border-red-500/20">
                                Error
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                            <span>{timeAgo(result.scrapedAt)}</span>
                            <span className="hidden sm:inline">{formatDate(result.scrapedAt)}</span>
                            {result.totalItems > 0 && <span>{result.totalItems} items</span>}
                            {result.matches.length > 0 && <span className="text-emerald-400">{result.matches.length} matches</span>}
                          </div>
                        </div>
                        {(hasChanges || result.error) && (
                          isExpanded
                            ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                            : <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </button>

                    {/* Expanded details */}
                    {isExpanded && (
                      <div className="mt-4 pt-4 border-t border-border/30 space-y-4">
                        {/* Error */}
                        {result.error && (
                          <div className="rounded-lg bg-red-500/5 border border-red-500/10 p-3">
                            <p className="text-xs font-medium text-red-400 mb-1">Error</p>
                            <p className="text-sm text-muted-foreground">{result.error}</p>
                          </div>
                        )}

                        {/* Changes detail */}
                        {result.changes && hasChanges && (
                          <div className="space-y-3">
                            {/* Added items */}
                            {result.changes.added.length > 0 && (
                              <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                  <Plus className="h-3.5 w-3.5 text-emerald-400" />
                                  <p className="text-xs font-semibold text-emerald-400">
                                    {result.changes.added.length} new item{result.changes.added.length !== 1 ? "s" : ""}
                                  </p>
                                </div>
                                <div className="space-y-1">
                                  {result.changes.added.slice(0, 5).map((item, i) => (
                                    <div key={i} className="rounded bg-emerald-500/5 border border-emerald-500/10 px-3 py-2 text-xs">
                                      <span className="font-medium">{String((item as Record<string, unknown>).title ?? "")}</span>
                                      {(item as Record<string, unknown>).price != null && (
                                        <span className="ml-2 text-muted-foreground">
                                          ${Number((item as Record<string, unknown>).price).toLocaleString()}
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                  {result.changes.added.length > 5 && (
                                    <p className="text-xs text-muted-foreground pl-3">
                                      +{result.changes.added.length - 5} more
                                    </p>
                                  )}
                                </div>
                              </div>
                            )}

                            {/* Removed items */}
                            {result.changes.removed.length > 0 && (
                              <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                  <Minus className="h-3.5 w-3.5 text-red-400" />
                                  <p className="text-xs font-semibold text-red-400">
                                    {result.changes.removed.length} removed
                                  </p>
                                </div>
                                <div className="space-y-1">
                                  {result.changes.removed.slice(0, 5).map((item, i) => (
                                    <div key={i} className="rounded bg-red-500/5 border border-red-500/10 px-3 py-2 text-xs line-through text-muted-foreground">
                                      {String((item as Record<string, unknown>).title ?? "")}
                                    </div>
                                  ))}
                                  {result.changes.removed.length > 5 && (
                                    <p className="text-xs text-muted-foreground pl-3">
                                      +{result.changes.removed.length - 5} more
                                    </p>
                                  )}
                                </div>
                              </div>
                            )}

                            {/* Price changes */}
                            {result.changes.priceChanges.length > 0 && (
                              <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                  <TrendingDown className="h-3.5 w-3.5 text-blue-400" />
                                  <p className="text-xs font-semibold text-blue-400">
                                    {result.changes.priceChanges.length} price change{result.changes.priceChanges.length !== 1 ? "s" : ""}
                                  </p>
                                </div>
                                <div className="space-y-1">
                                  {result.changes.priceChanges.map((pc, i) => (
                                    <div key={i} className="rounded bg-background/50 border border-border/30 px-3 py-2 text-xs flex items-center justify-between">
                                      <span className="font-medium truncate max-w-xs">{pc.title}</span>
                                      <div className="flex items-center gap-2 shrink-0">
                                        <span className="text-muted-foreground line-through">${pc.oldPrice.toLocaleString()}</span>
                                        <span className="font-semibold">${pc.newPrice.toLocaleString()}</span>
                                        <span className={`font-semibold ${pc.change < 0 ? "text-emerald-400" : "text-red-400"}`}>
                                          {pc.change < 0 ? (
                                            <span className="flex items-center gap-0.5">
                                              <TrendingDown className="h-3 w-3" />
                                              {Math.abs(pc.changePercent)}%
                                            </span>
                                          ) : (
                                            <span className="flex items-center gap-0.5">
                                              <TrendingUp className="h-3 w-3" />
                                              {pc.changePercent}%
                                            </span>
                                          )}
                                        </span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
