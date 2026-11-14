"use client";

import { useState } from "react";
import { Loader2, RefreshCw, UserRound } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { timeAgo } from "@/lib/time";
import { formatDate } from "./format";
import { startImpersonating } from "./impersonation";
import { QueryError } from "./query-error";
import { useOneShotQuery } from "./use-one-shot-query";

export function UserDetailSheet({ userId, onOpenChange }: { userId: string | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={userId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-2xl!">
        {userId && <UserDetail userId={userId} />}
      </SheetContent>
    </Sheet>
  );
}

function UserDetail({ userId }: { userId: string }) {
  const { data, loading, error, refresh } = useOneShotQuery(api.admin.userDetail, { userId });
  const [impersonating, setImpersonating] = useState(false);

  async function impersonate() {
    setImpersonating(true);
    // Stays disabled on success: a second click would run as the user.
    if (!(await startImpersonating(userId))) setImpersonating(false);
  }

  if (error) return <div className="p-4"><QueryError error={error} onRetry={refresh} /></div>;
  if (!data) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { user, tier, ban } = data;

  return (
    <>
      <SheetHeader className="pr-12">
        <SheetTitle className="truncate">{user?.email ?? "Deleted user"}</SheetTitle>
        <SheetDescription className="font-mono text-xs select-all">{userId}</SheetDescription>
        <div className="flex flex-wrap gap-2 pt-3">
          <Button size="sm" onClick={impersonate} disabled={!user || impersonating}>
            {impersonating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserRound className="h-3.5 w-3.5" />}
            Impersonate
          </Button>
          <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </SheetHeader>

      <div className="space-y-6 px-4 pb-6">
        {ban && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            Banned {timeAgo(ban.bannedAt)} by {ban.bannedBy}
            {ban.reason && <span className="text-muted-foreground">: {ban.reason}</span>}
          </div>
        )}

        <Section title="Account">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
            <Field label="Name" value={user?.name || "–"} />
            <Field label="Joined" value={user ? formatDate(user.createdAt) : "–"} />
            <Field label="Last seen" value={timeAgo(data.lastSeenAt ?? undefined)} />
            <Field label="First scan" value={data.activatedAt ? formatDate(data.activatedAt) : "Not yet"} />
            <Field label="Email verified" value={user?.emailVerified ? "Yes" : "No"} />
            <Field
              label="Plan"
              value={[
                tier?.tier ?? "free",
                tier?.grantUntil && `${tier.grantSource === "pass" ? "pass" : "trial"} until ${formatDate(tier.grantUntil)}`,
                tier?.cancelledAt && `cancelling${tier.periodEnd ? `, ends ${formatDate(tier.periodEnd)}` : ""}`,
              ].filter(Boolean).join(" · ")}
            />
            {tier?.polarCustomerId && <Field label="Polar customer" value={tier.polarCustomerId} mono />}
            <Field label="Alert channels" value={["in-app", ...data.channels].join(", ")} />
          </dl>
        </Section>

        <Section title={`Monitors (${data.monitors.length})`}>
          {data.monitors.length === 0 ? (
            <Empty>No monitors.</Empty>
          ) : (
            <ul className="divide-y divide-border/30 rounded-lg border border-border/30">
              {data.monitors.map((m) => (
                <li key={m.id} className="space-y-0.5 p-3">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={m.status} />
                    <span className="truncate font-medium">{m.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">every {m.checkInterval}</span>
                  </div>
                  <a href={m.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-muted-foreground hover:underline">
                    {m.url}
                  </a>
                  <p className="text-xs text-muted-foreground">
                    Checked {timeAgo(m.lastCheckedAt ?? undefined)} · {m.matchCount} matches
                    {m.lastMatchAt && `, last ${timeAgo(m.lastMatchAt)}`}
                  </p>
                  {m.lastError && <p className="text-xs text-destructive line-clamp-2">{m.lastError}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent scans">
          {data.scans.length === 0 ? (
            <Empty>No scans.</Empty>
          ) : (
            <ul className="space-y-1.5">
              {data.scans.map((s) => (
                <li key={s.id} className="text-xs">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={s.status} />
                    <span className="truncate">{s.monitorName ?? s.url}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground">
                      {s.itemCount !== null && `${s.itemCount} items · `}
                      {(s.durationMs / 1000).toFixed(1)}s · {timeAgo(s.createdAt)}
                    </span>
                  </div>
                  {s.error && <p className="mt-0.5 text-destructive line-clamp-2">{s.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="grid gap-6 sm:grid-cols-2">
          <Section title="Recent alerts">
            {data.notifications.length === 0 ? (
              <Empty>No alerts.</Empty>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {data.notifications.map((n) => (
                  <li key={n.id} className="flex gap-2">
                    <span className="truncate">{n.title}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground">{n.channel} · {timeAgo(n.sentAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Recent emails">
            {data.emails.length === 0 ? (
              <Empty>No emails.</Empty>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {data.emails.map((e) => (
                  <li key={e.id} className="flex gap-2">
                    <span className="truncate">{e.kind}</span>
                    <span className={`ml-auto shrink-0 ${e.status === "bounced" || e.status === "failed" || e.status === "complained" ? "text-destructive" : "text-muted-foreground"}`}>
                      {e.status} · {timeAgo(e.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`truncate ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function StatusBadge({ status }: { status: string }) {
  const colour =
    status === "active" || status === "success"
      ? "bg-emerald-500/10 text-success border-emerald-500/20"
      : status === "error" || status === "timeout"
        ? "bg-destructive/10 text-destructive border-destructive/20"
        : "bg-muted text-muted-foreground border-border";
  return <Badge className={`shrink-0 text-xs ${colour}`}>{status}</Badge>;
}
