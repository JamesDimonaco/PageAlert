"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AiInsightsCard } from "@/components/prowl/ai-insights";
import {
  ExternalLink,
  Clock,
  Zap,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Quote,
} from "lucide-react";
import type { ExtractedItem, ExtractionSchema } from "@prowl/shared";
import { timeAgo } from "@/lib/time";
import { formatPrice, toSafeUrl } from "@/lib/format";

interface OverviewTabProps {
  monitor: {
    url: string;
    prompt: string;
    checkInterval: string;
    lastCheckedAt?: number;
    matchCount: number;
    checkCount?: number;
    schema?: unknown;
  };
  matches: ExtractedItem[];
  totalItems: number;
}

export function OverviewTab({ monitor, matches, totalItems }: OverviewTabProps) {
  const [insightsOpen, setInsightsOpen] = useState(false);
  const schema = monitor.schema as ExtractionSchema | undefined;

  return (
    <div className="space-y-8">
      {/* Prompt */}
      <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
        <CardContent className="p-6">
          <div className="flex items-start gap-3">
            <Quote className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">Looking for</p>
              <p className="text-base font-medium leading-relaxed">{monitor.prompt}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stats row */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">URL</p>
            <a href={monitor.url} target="_blank" rel="noopener noreferrer"
              className="text-sm font-medium text-primary hover:underline flex items-center gap-1.5 break-all">
              {monitor.url.replace(/^https?:\/\//, "")}
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Interval</p>
            <p className="text-sm font-semibold flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              Every {monitor.checkInterval}
            </p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Matches</p>
            <p className="text-sm font-semibold flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-primary" />
              {matches.length} of {totalItems} items
            </p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Checks</p>
            <p className="text-sm font-semibold">{monitor.checkCount ?? 0} total · {timeAgo(monitor.lastCheckedAt)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Top matches */}
      {matches.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            Top Matches
            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
              {matches.length}
            </Badge>
          </h3>
          <div className="space-y-2">
            {matches.slice(0, 5).map((item, i) => {
              const title = String(item.title ?? item.name ?? `Item ${i + 1}`);
              const safeUrl = toSafeUrl(item.url);
              const price = formatPrice(item.price);
              return (
                <Card key={i} className="border-emerald-500/20 bg-emerald-500/5 shadow-sm shadow-black/5">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {safeUrl ? (
                            <a href={safeUrl} target="_blank" rel="noopener noreferrer"
                              className="text-sm font-medium hover:text-primary hover:underline transition-colors truncate">
                              {title}
                            </a>
                          ) : (
                            <p className="text-sm font-medium truncate">{title}</p>
                          )}
                          {safeUrl && <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />}
                        </div>
                      </div>
                      {price && (
                        <span className="text-sm font-bold shrink-0">{price}</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {matches.length > 5 && (
              <p className="text-xs text-muted-foreground pl-2">+{matches.length - 5} more — see Items tab</p>
            )}
          </div>
        </div>
      )}

      {matches.length === 0 && totalItems > 0 && (
        <Card className="border-border/30 bg-card/30 shadow-sm shadow-black/5">
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium text-muted-foreground">No matches right now</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              {totalItems} items being monitored. You&apos;ll be notified when something matches.
            </p>
          </CardContent>
        </Card>
      )}

      {/* AI Insights - collapsible */}
      {schema?.insights && (
        <div>
          <button
            onClick={() => setInsightsOpen(!insightsOpen)}
            className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            {insightsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            AI Understanding
            <Badge variant="outline" className={`text-xs ml-1 ${
              (schema.insights.confidence ?? 0) >= 80
                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                : (schema.insights.confidence ?? 0) >= 50
                  ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                  : "bg-red-500/10 text-red-400 border-red-500/20"
            }`}>
              {schema.insights.confidence}%
            </Badge>
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
