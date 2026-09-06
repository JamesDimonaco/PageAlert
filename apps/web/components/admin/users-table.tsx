"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { Loader2, RefreshCw, Search, Mail, Gift, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { timeAgo } from "@/lib/time";
import { GrantTrialDialog } from "./grant-trial-dialog";
import { formatDate, formatUsd } from "./format";
import { useOneShotQuery } from "./use-one-shot-query";

type PlanFilter = "all" | "free" | "paying" | "trial" | "cancelling";

export function AdminUsersTable({
  selectedIds,
  onSelectionChange,
  onEmailSelected,
}: {
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onEmailSelected: () => void;
}) {
  const { data: users, loading, refresh } = useOneShotQuery(api.admin.listUsers, {});
  const endTrial = useMutation(api.admin.endTrial);
  const [search, setSearch] = useState("");
  const [plan, setPlan] = useState<PlanFilter>("all");
  const [trialTarget, setTrialTarget] = useState<string[] | null>(null);

  const filtered = useMemo(() => {
    if (!users) return [];
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (q && !u.email.toLowerCase().includes(q) && !u.name.toLowerCase().includes(q)) return false;
      switch (plan) {
        case "free": return u.tier === "free";
        case "paying": return u.isPaying;
        case "trial": return u.grantUntil !== null;
        case "cancelling": return u.cancelledAt !== null && u.isPaying;
        default: return true;
      }
    });
  }, [users, search, plan]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((u) => selectedIds.has(u.userId));

  function toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    onSelectionChange(next);
  }

  function toggleAllFiltered() {
    const next = new Set(selectedIds);
    if (allFilteredSelected) filtered.forEach((u) => next.delete(u.userId));
    else filtered.forEach((u) => next.add(u.userId));
    onSelectionChange(next);
  }

  async function handleEndTrial(userId: string, email: string) {
    try {
      await endTrial({ userId });
      toast.success(`Ended trial for ${email}`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to end trial");
    }
  }

  if (!users) {
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

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by email or name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={plan} onValueChange={(v) => v && setPlan(v as PlanFilter)}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All plans</SelectItem>
            <SelectItem value="free">Free</SelectItem>
            <SelectItem value="paying">Paying</SelectItem>
            <SelectItem value="trial">On trial</SelectItem>
            <SelectItem value="cancelling">Cancelling</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {filtered.length} of {users.length} users
          {selectedIds.size > 0 && ` · ${selectedIds.size} selected`}
        </span>
        <div className="flex-1" />
        {selectedIds.size > 0 && (
          <>
            <Button size="sm" variant="outline" onClick={() => onSelectionChange(new Set())}>
              <X className="h-3.5 w-3.5" /> Clear
            </Button>
            <Button size="sm" variant="outline" onClick={() => setTrialTarget([...selectedIds])}>
              <Gift className="h-3.5 w-3.5" /> Grant trial
            </Button>
            <Button size="sm" onClick={onEmailSelected}>
              <Mail className="h-3.5 w-3.5" /> Email selected
            </Button>
          </>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/30">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="p-3 w-10">
                <input
                  type="checkbox"
                  aria-label="Select all filtered users"
                  checked={allFilteredSelected}
                  onChange={toggleAllFiltered}
                  className="h-4 w-4 accent-primary"
                />
              </th>
              <th className="p-3 text-left font-medium">User</th>
              <th className="p-3 text-left font-medium">Plan</th>
              <th className="p-3 text-right font-medium">$/mo</th>
              <th className="p-3 text-right font-medium">Monitors</th>
              <th className="p-3 text-left font-medium">Joined</th>
              <th className="p-3 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {filtered.map((u) => {
              const selected = selectedIds.has(u.userId);
              return (
                <tr key={u.userId} className={selected ? "bg-primary/5" : "hover:bg-muted/20"}>
                  <td className="p-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${u.email}`}
                      checked={selected}
                      onChange={() => toggle(u.userId)}
                      className="h-4 w-4 accent-primary"
                    />
                  </td>
                  <td className="p-3">
                    <div className="font-medium truncate max-w-[260px]">{u.email}</div>
                    {u.name && <div className="text-xs text-muted-foreground truncate max-w-[260px]">{u.name}</div>}
                  </td>
                  <td className="p-3">
                    <PlanBadge tier={u.tier} grantUntil={u.grantUntil} cancelledAt={u.cancelledAt} periodEnd={u.periodEnd} />
                  </td>
                  <td className="p-3 text-right tabular-nums">{u.monthlyCents > 0 ? formatUsd(u.monthlyCents) : "–"}</td>
                  <td className="p-3 text-right tabular-nums" title={u.lastMonitorAt ? `Last created ${timeAgo(u.lastMonitorAt)}` : undefined}>
                    {u.monitorCount}
                    {u.monitorCount > 0 && <span className="text-muted-foreground"> ({u.activeMonitors} active)</span>}
                  </td>
                  <td className="p-3 text-muted-foreground whitespace-nowrap" title={formatDate(u.createdAt)}>{timeAgo(u.createdAt)}</td>
                  <td className="p-3 text-right whitespace-nowrap">
                    {u.grantUntil ? (
                      <Button size="sm" variant="ghost" onClick={() => handleEndTrial(u.userId, u.email)}>End trial</Button>
                    ) : !u.isPaying ? (
                      <Button size="sm" variant="ghost" onClick={() => setTrialTarget([u.userId])}>Grant trial</Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-muted-foreground">No users match.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <GrantTrialDialog
        open={trialTarget !== null}
        onOpenChange={(open) => { if (!open) setTrialTarget(null); }}
        userIds={trialTarget ?? []}
        onDone={refresh}
      />
    </div>
  );
}

function PlanBadge({
  tier,
  grantUntil,
  cancelledAt,
  periodEnd,
}: {
  tier: "free" | "pro" | "max";
  grantUntil: number | null;
  cancelledAt: number | null;
  periodEnd: number | null;
}) {
  if (tier === "free") return <Badge variant="outline" className="text-[10px]">Free</Badge>;
  const label = tier === "max" ? "Max" : "Pro";
  const colour = tier === "max"
    ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
    : "bg-primary/10 text-primary border-primary/20";
  return (
    <div className="flex flex-col gap-0.5">
      <Badge className={`text-[10px] w-fit ${colour}`}>{label}{grantUntil ? " trial" : ""}</Badge>
      {grantUntil && <span className="text-[11px] text-muted-foreground">until {formatDate(grantUntil)}</span>}
      {cancelledAt && !grantUntil && (
        <span className="text-[11px] text-amber-400">cancelling{periodEnd ? `, ends ${formatDate(periodEnd)}` : ""}</span>
      )}
    </div>
  );
}
