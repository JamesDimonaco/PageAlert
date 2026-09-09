"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { displayHost } from "@/convex/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/time";
import { formatDate } from "./format";
import { QueryError } from "./query-error";
import { useOneShotQuery } from "./use-one-shot-query";

const ERROR_TRUNCATE = 100;

export function AdminMonitorOps() {
  const { data: parked, loading, error, refresh } = useOneShotQuery(api.adminMonitors.parkedMonitors, {});
  const unparkMonitor = useMutation(api.adminMonitors.unparkMonitor);
  const [confirming, setConfirming] = useState<Id<"monitors"> | null>(null);
  const [busy, setBusy] = useState<Id<"monitors"> | null>(null);

  async function handleUnpark(monitorId: Id<"monitors">) {
    if (confirming !== monitorId) {
      setConfirming(monitorId);
      return;
    }
    setConfirming(null);
    setBusy(monitorId);
    try {
      const result = await unparkMonitor({ monitorId });
      toast.success(`${result.name} is back in the queue`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to un-park monitor");
    } finally {
      setBusy(null);
    }
  }

  if (error) return <QueryError error={error} onRetry={refresh} />;
  if (!parked) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Stopped monitors</CardTitle>
          <p className="text-xs text-muted-foreground">
            These sites defeat our anti-bot proxy, so we stopped paying to be blocked every 6 hours.
            Un-parking gives it another go — and spends Scrapfly credits doing it.
          </p>
        </CardHeader>
        <CardContent>
          {parked.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">Nothing is parked right now.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border/30">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3 text-left font-medium">Monitor</th>
                    <th className="p-3 text-left font-medium">Host</th>
                    <th className="p-3 text-left font-medium">Owner</th>
                    <th className="p-3 text-left font-medium">Stopped</th>
                    <th className="p-3 text-right font-medium"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {parked.map((m) => {
                    const isConfirming = confirming === m._id;
                    const isBusy = busy === m._id;
                    return (
                      <tr key={m._id} className="hover:bg-muted/20">
                        <td className="p-3">
                          <div className="font-medium truncate max-w-[240px]">{m.name}</div>
                          {m.lastError && (
                            <div className="text-xs text-muted-foreground truncate max-w-[320px]" title={m.lastError}>
                              {m.lastError.length > ERROR_TRUNCATE ? `${m.lastError.slice(0, ERROR_TRUNCATE)}…` : m.lastError}
                            </div>
                          )}
                        </td>
                        <td className="p-3">
                          <a
                            href={m.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            {displayHost(m.url)}
                          </a>
                        </td>
                        <td className="p-3 text-muted-foreground truncate max-w-[220px]">{m.userEmail ?? "–"}</td>
                        <td className="p-3 text-muted-foreground whitespace-nowrap" title={formatDate(m.updatedAt)}>{timeAgo(m.updatedAt)}</td>
                        <td className="p-3 text-right whitespace-nowrap">
                          <Button
                            size="sm"
                            variant={isConfirming ? "default" : "outline"}
                            disabled={isBusy}
                            onClick={() => handleUnpark(m._id)}
                            onBlur={() => setConfirming((c) => (c === m._id ? null : c))}
                          >
                            {isBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            {isConfirming ? "Confirm un-park?" : "Un-park"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
