"use client";

import { use, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Radar,
  Loader2,
  CheckCircle2,
  ExternalLink,
  Mail,
  ArrowRight,
  Zap,
  Shield,
  AlertTriangle,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { trackEvent } from "@/lib/posthog";

export default function TryResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const monitorId = id as Id<"monitors">;
  const monitor = useQuery(api.anonymous.getAnonymous, { monitorId });

  const [email, setEmail] = useState("");
  const [claiming, setClaiming] = useState(false);
  const claimMutation = useMutation(api.anonymous.claimWithEmail);

  // Get anonId from localStorage
  const anonId = typeof window !== "undefined"
    ? (() => {
        try {
          const stored = localStorage.getItem("pagealert_anon_monitor");
          if (stored) {
            const data = JSON.parse(stored);
            if (data.monitorId === id) return data.anonId as string;
          }
        } catch {}
        return null;
      })()
    : null;

  if (monitor === undefined) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (monitor === null) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="mx-auto max-w-3xl px-4 py-20 text-center">
          <AlertTriangle className="h-10 w-10 text-muted-foreground/40 mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Scan not found</h1>
          <p className="text-muted-foreground mb-6">This scan may have expired or doesn&apos;t exist.</p>
          <Link href="/" className={buttonVariants()}>Try a new scan</Link>
        </div>
      </div>
    );
  }

  const schema = monitor.schema as Record<string, unknown> | undefined;
  const items = Array.isArray(schema?.items) ? schema.items as Record<string, unknown>[] : [];
  const insights = schema?.insights as Record<string, unknown> | undefined;
  const confidence = Number(insights?.confidence ?? 0);
  const hasClaimed = monitor.hasClaimed;

  async function handleClaim() {
    if (!email || !anonId) return;
    setClaiming(true);
    try {
      await claimMutation({ monitorId, anonId, email });
      trackEvent("anonymous_email_captured", { monitorId });
      toast.success("Email saved! We'll notify you when matches are found.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save email");
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="mx-auto max-w-3xl px-4 sm:px-6 py-10 sm:py-16 space-y-8">
        {/* Status banner */}
        {monitor.status === "scanning" && (
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="p-5 flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <div>
                <p className="text-sm font-semibold">Scanning in progress...</p>
                <p className="text-xs text-muted-foreground">AI is analysing the page. This usually takes 10-30 seconds.</p>
              </div>
            </CardContent>
          </Card>
        )}

        {monitor.status === "error" && (
          <Card className="border-red-500/30 bg-red-500/5">
            <CardContent className="p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-red-400">Scan failed</p>
                  <p className="text-sm text-muted-foreground mt-1">{monitor.lastError ?? "Something went wrong"}</p>
                  <Link href="/" className="text-xs text-primary hover:underline mt-2 inline-block">Try a different URL</Link>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Monitor info */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{monitor.name}</h1>
          <p className="text-muted-foreground mt-2 text-sm break-all">
            <a href={monitor.url} target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
              {monitor.url} <ExternalLink className="h-3 w-3 inline ml-1" />
            </a>
          </p>
          <p className="mt-3 text-sm">
            Looking for: <span className="font-medium">&ldquo;{monitor.prompt}&rdquo;</span>
          </p>
        </div>

        {/* Results */}
        {monitor.status === "active" && items.length > 0 && (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Card className="border-border/30 bg-card/50">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground mb-1">Items Found</p>
                  <p className="text-2xl font-bold">{items.length}</p>
                </CardContent>
              </Card>
              <Card className="border-border/30 bg-card/50">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground mb-1">Matches</p>
                  <p className="text-2xl font-bold text-primary">{monitor.matchCount}</p>
                </CardContent>
              </Card>
              {confidence > 0 && (
                <Card className="border-border/30 bg-card/50">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground mb-1">AI Confidence</p>
                    <p className={`text-2xl font-bold ${confidence >= 80 ? "text-emerald-400" : confidence >= 50 ? "text-amber-400" : "text-red-400"}`}>
                      {confidence}%
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Items list */}
            <div>
              <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                Extracted Items
                <Badge variant="outline" className="text-xs">{items.length}</Badge>
              </h2>
              <div className="space-y-2">
                {items.slice(0, 10).map((item, i) => {
                  const title = String(item.title ?? item.name ?? `Item ${i + 1}`);
                  const price = item.price != null ? `$${Number(item.price).toLocaleString()}` : null;
                  const url = item.url ? String(item.url) : null;

                  return (
                    <Card key={i} className="border-border/30 bg-card/50">
                      <CardContent className="p-3 sm:p-4">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            {url ? (
                              <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium hover:text-primary transition-colors truncate block">
                                {title}
                              </a>
                            ) : (
                              <p className="text-sm font-medium truncate">{title}</p>
                            )}
                          </div>
                          {price && <span className="text-sm font-bold shrink-0">{price}</span>}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
                {items.length > 10 && (
                  <p className="text-xs text-muted-foreground text-center py-2">
                    +{items.length - 10} more items — create an account to see all
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        {monitor.status === "active" && items.length === 0 && (
          <Card className="border-border/30 bg-card/30">
            <CardContent className="py-10 text-center">
              <p className="text-sm font-medium text-muted-foreground">No items found on this page</p>
              <p className="text-xs text-muted-foreground/70 mt-1">The AI couldn&apos;t extract structured data. Try a different URL or prompt.</p>
              <Link href="/" className={buttonVariants({ variant: "outline", className: "mt-4" })}>
                Try again
              </Link>
            </CardContent>
          </Card>
        )}

        {/* Email capture */}
        {monitor.status === "active" && !hasClaimed && anonId && (
          <Card className="border-primary/30 bg-primary/5 shadow-md">
            <CardContent className="p-5 sm:p-6">
              <div className="flex items-start gap-3 mb-4">
                <Mail className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold">Want to get notified?</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Enter your email and we&apos;ll monitor this page every 24 hours. We&apos;ll email you when new matches appear.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="flex-1"
                  onKeyDown={(e) => e.key === "Enter" && handleClaim()}
                />
                <Button onClick={handleClaim} disabled={claiming || !email} className="shrink-0 gap-1.5">
                  {claiming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                  Notify me
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {hasClaimed && (
          <Card className="border-emerald-500/30 bg-emerald-500/5">
            <CardContent className="p-5 flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              <div>
                <p className="text-sm font-semibold text-emerald-400">You&apos;ll be notified!</p>
                <p className="text-xs text-muted-foreground">We&apos;re checking this page every 24 hours. Create an account to manage your monitor and check faster.</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* CTA to sign up */}
        <Card className="border-border/30 bg-card/50">
          <CardContent className="p-5 sm:p-6 text-center">
            <Zap className="h-8 w-8 text-primary mx-auto mb-3" />
            <h3 className="text-lg font-bold mb-1">Want more?</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Create a free account for up to 3 monitors, faster check intervals, and Telegram notifications.
            </p>
            <Link href="/login" className={buttonVariants({ className: "gap-2" })}>
              Create free account
              <ArrowRight className="h-4 w-4" />
            </Link>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-border/30 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Radar className="h-5 w-5 text-primary" />
          </div>
          <span className="text-xl font-bold tracking-tight">PageAlert</span>
        </Link>
        <Link href="/login" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          Sign in
        </Link>
      </div>
    </header>
  );
}
