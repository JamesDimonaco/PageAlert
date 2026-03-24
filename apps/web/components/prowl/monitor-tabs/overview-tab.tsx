"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MatchConditionsEditor } from "@/components/prowl/match-conditions-editor";
import { AiInsightsCard } from "@/components/prowl/ai-insights";
import {
  ExternalLink,
  Loader2,
  Save,
  RotateCcw,
  RefreshCw,
} from "lucide-react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { MatchConditions, ExtractionSchema } from "@prowl/shared";
import { toast } from "sonner";
import { timeAgo } from "@/lib/time";

interface OverviewTabProps {
  monitorId: Id<"monitors">;
  monitor: {
    url: string;
    checkInterval: string;
    lastCheckedAt?: number;
    matchCount: number;
    checkCount?: number;
    schema?: unknown;
  };
  matchCount: number;
  totalItems: number;
}

export function OverviewTab({ monitorId, monitor, matchCount, totalItems }: OverviewTabProps) {
  const [editedConditions, setEditedConditions] = useState<MatchConditions | null>(null);
  const [saving, setSaving] = useState(false);
  const updateMutation = useMutation(api.monitors.update);

  const schema = monitor.schema as ExtractionSchema | undefined;
  const conditions = editedConditions ?? schema?.matchConditions ?? {};
  const hasEdits = editedConditions !== null;

  async function saveConditions() {
    if (!schema || !editedConditions) return;
    setSaving(true);
    try {
      await updateMutation({
        id: monitorId,
        schema: { ...schema, matchConditions: editedConditions },
      });
      setEditedConditions(null);
      toast.success("Filters updated");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Info cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">URL</p>
            {(() => {
              try {
                const hostname = new URL(monitor.url).hostname;
                return (
                  <a href={monitor.url} target="_blank" rel="noopener noreferrer"
                    className="text-sm font-medium text-primary hover:underline flex items-center gap-1.5">
                    {hostname}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                );
              } catch {
                return <p className="text-sm font-medium">{monitor.url}</p>;
              }
            })()}
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Interval</p>
            <p className="text-sm font-semibold">Every {monitor.checkInterval}</p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Matches</p>
            <p className="text-sm font-semibold">{matchCount} of {totalItems} items</p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Checks</p>
            <p className="text-sm font-semibold">{monitor.checkCount ?? 0} total · {timeAgo(monitor.lastCheckedAt)}</p>
          </CardContent>
        </Card>
      </div>

      {/* AI Insights */}
      {schema?.insights && <AiInsightsCard insights={schema.insights} />}

      {/* Match Filters */}
      {schema && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold tracking-tight">Filters</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Edit keywords to re-filter the existing data. No new scrape needed.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {hasEdits && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setEditedConditions(null)}>
                    <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Discard
                  </Button>
                  <Button size="sm" className="gap-1.5" onClick={saveConditions} disabled={saving}>
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save & Apply
                  </Button>
                </>
              )}
            </div>
          </div>
          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardContent className="p-6">
              <MatchConditionsEditor conditions={conditions} onChange={setEditedConditions} />
              {hasEdits && (
                <p className="text-xs text-primary mt-4 flex items-center gap-1.5">
                  <RefreshCw className="h-3 w-3" />
                  Preview updated below — click &ldquo;Save & Apply&rdquo; to keep these changes
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
