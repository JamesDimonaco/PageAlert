"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { timeAgo } from "@/lib/time";
import { QueryError } from "./query-error";
import { useOneShotQuery } from "./use-one-shot-query";

type Step = "day0" | "day1" | "day3" | "day7";
const STEP_LABEL: Record<Step, string> = { day0: "Day 0", day1: "Day 1", day3: "Day 3", day7: "Day 7" };

type SendStatus = Doc<"emailSends">["status"];
type SendFilter = "all" | SendStatus;
const SEND_FILTERS: SendFilter[] = ["all", "delivered", "bounced", "complained", "failed", "sent"];

function badgeForStatus(status: SendStatus) {
  if (status === "bounced" || status === "complained" || status === "failed") {
    return <Badge variant="destructive">{status}</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

export function AdminEmailOps() {
  return (
    <div className="space-y-6">
      <OnboardingQueue />
      <RecentSends />
    </div>
  );
}

function OnboardingQueue() {
  const { data, loading, error, refresh } = useOneShotQuery(api.adminEmails.emailQueue, {});
  const retireStaleQueued = useMutation(api.adminEmails.retireStaleQueued);
  const requeueFailed = useMutation(api.adminEmails.requeueFailed);
  const [busy, setBusy] = useState<string | null>(null);
  // Second click on the same button confirms the action.
  const [confirming, setConfirming] = useState<string | null>(null);

  async function handleRetire(step: Step) {
    const key = `retire-${step}`;
    if (confirming !== key) {
      setConfirming(key);
      return;
    }
    setConfirming(null);
    setBusy(key);
    try {
      const result = await retireStaleQueued({ step });
      toast.success(`Retired ${result.retired} stale ${STEP_LABEL[step]} row${result.retired === 1 ? "" : "s"}${result.moreRemain ? " — more remain, click again" : ""}`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to retire stale rows");
    } finally {
      setBusy(null);
    }
  }

  // day0 only — see requeueFailed in adminEmails.ts. Nothing sends the other
  // steps yet, so requeueing one would move a row that never gets picked up.
  async function handleRequeue(step: "day0") {
    const key = `requeue-${step}`;
    if (confirming !== key) {
      setConfirming(key);
      return;
    }
    setConfirming(null);
    setBusy(key);
    try {
      const result = await requeueFailed({ step });
      toast.success(`Requeued ${result.requeued} failed ${STEP_LABEL[step]} row${result.requeued === 1 ? "" : "s"}${result.moreRemain ? " — more remain, click again" : ""}`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to requeue failed rows");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-semibold">Onboarding queue</CardTitle>
        <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Only day 0 sends today — day 1/3/7 are queued for a later phase and are expected to sit pending until it ships.
        </p>
        {error && <QueryError error={error} onRetry={refresh} />}
        {!error && !data && (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {data && (
          <div className="overflow-x-auto rounded-lg border border-border/30">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-left font-medium">Step</th>
                  <th className="p-3 text-right font-medium">Pending</th>
                  <th className="p-3 text-right font-medium">Stale</th>
                  <th className="p-3 text-right font-medium">Sent</th>
                  <th className="p-3 text-right font-medium">Failed</th>
                  <th className="p-3 text-right font-medium">Skipped</th>
                  <th className="p-3 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {data.map((row) => (
                  <tr key={row.step} className="hover:bg-muted/20">
                    <td className="p-3 font-medium" title={row.truncated ? "Counts capped — more rows exist than shown" : undefined}>
                      {STEP_LABEL[row.step]}
                      {row.truncated && <span className="text-muted-foreground">*</span>}
                    </td>
                    <td className="p-3 text-right tabular-nums">{row.pending}</td>
                    <td className="p-3 text-right tabular-nums">{row.stalePending}</td>
                    <td className="p-3 text-right tabular-nums">{row.sent}</td>
                    <td className="p-3 text-right tabular-nums">{row.failed}</td>
                    <td className="p-3 text-right tabular-nums">{row.skipped}</td>
                    <td className="p-3 text-right whitespace-nowrap">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={row.stalePending === 0 || busy !== null}
                          onClick={() => handleRetire(row.step)}
                        >
                          {busy === `retire-${row.step}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                          {confirming === `retire-${row.step}` ? "Confirm?" : `Retire ${row.stalePending} stale`}
                        </Button>
                        {row.step === "day0" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={row.failed === 0 || busy !== null}
                            onClick={() => handleRequeue("day0")}
                          >
                            {busy === "requeue-day0" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            {confirming === "requeue-day0" ? "Confirm?" : `Requeue ${row.failed} failed`}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.some((row) => row.truncated) && (
          <p className="text-xs text-muted-foreground/70">* counts are capped at 500 rows per status — the true number is at least this high.</p>
        )}
      </CardContent>
    </Card>
  );
}

function RecentSends() {
  const [status, setStatus] = useState<SendFilter>("all");
  const [limit, setLimit] = useState(50);
  const { data, loading, error, refresh } = useOneShotQuery(
    api.adminEmails.recentSends,
    status === "all" ? { limit } : { status, limit },
  );

  return (
    <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm font-semibold">Recent sends</CardTitle>
        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={(v) => v && setStatus(v as SendFilter)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEND_FILTERS.map((f) => (
                <SelectItem key={f} value={f}>{f === "all" ? "All" : f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(limit)} onValueChange={(v) => v && setLimit(Number(v))}>
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[50, 100, 200].map((n) => (
                <SelectItem key={n} value={String(n)}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          There is no retry for a failed match, error, or price alert — emailSends stores delivery metadata only, not the rendered
          content, so those cannot be resent from here. A send sitting at &quot;sent&quot; means Resend accepted it and no delivery
          webhook has arrived yet, not that it&apos;s stuck.
        </p>
        {error && <QueryError error={error} onRetry={refresh} />}
        {!error && !data && (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {data && (
          <div className="overflow-x-auto rounded-lg border border-border/30">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-left font-medium">To</th>
                  <th className="p-3 text-left font-medium">Kind</th>
                  <th className="p-3 text-left font-medium">Status</th>
                  <th className="p-3 text-left font-medium">When</th>
                  <th className="p-3 text-left font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {data.map((s) => (
                  <tr key={s._id} className="hover:bg-muted/20">
                    <td className="p-3 truncate max-w-[220px]">{s.to}</td>
                    <td className="p-3 text-muted-foreground">{s.kind}</td>
                    <td className="p-3">{badgeForStatus(s.status)}</td>
                    <td className="p-3 text-muted-foreground whitespace-nowrap" title={new Date(s.createdAt).toLocaleString("en-GB")}>
                      {timeAgo(s.createdAt)}
                    </td>
                    <td className="p-3 text-muted-foreground truncate max-w-[280px]" title={s.error}>{s.error ?? "–"}</td>
                  </tr>
                ))}
                {data.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-muted-foreground">No sends match.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
