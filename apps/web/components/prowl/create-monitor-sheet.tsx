"use client";

import { useState, useEffect, useRef } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChannelSelector, defaultChannels, useConfiguredChannels, type Channel } from "@/components/prowl/channel-selector";
import { IntervalSelector } from "@/components/prowl/interval-selector";
import {
  Radar,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Mail,
  MessageCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMonitor } from "@/hooks/use-monitors";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "sonner";
import { sessionBoundParams } from "@prowl/shared";
import {
  readMonitorDraft,
  writeMonitorDraft,
  clearMonitorDraft,
} from "@/lib/monitor-draft";
import { trackMonitorDraftRestored, trackMonitorDraftCleared } from "@/lib/posthog";
import { MONITOR_MODES, type MonitorModeId } from "@/lib/monitor-modes";
import { ScanStep } from "./scan-step";
import type { ScanStage } from "@/hooks/use-create-monitor";

type CheckInterval = "5m" | "15m" | "30m" | "1h" | "6h" | "24h";

interface CreateMonitorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeMonitorId: Id<"monitors"> | null;
  isScanning: boolean;
  scanStage: ScanStage;
  onStartScan: (data: {
    name: string;
    url: string;
    prompt: string;
    checkInterval: CheckInterval;
    notificationChannels?: Channel[];
  }) => void;
  onCancelScan: () => void;
  onConfirm: () => void;
  cloneDefaults?: { name: string; url: string; prompt: string } | null;
  onCloneDefaultsConsumed?: () => void;
}

export function CreateMonitorSheet({
  open,
  onOpenChange,
  activeMonitorId,
  isScanning,
  scanStage,
  onStartScan,
  onCancelScan,
  onConfirm,
  cloneDefaults,
  onCloneDefaultsConsumed,
}: CreateMonitorSheetProps) {
  // Form state (only used before scan starts)
  const router = useRouter();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [checkInterval, setCheckInterval] = useState<CheckInterval>("1h");
  const [channels, setChannels] = useState<Channel[]>(["email"]);
  // Guidance only — the mode steers the prompt copy, never what gets scraped
  const [mode, setMode] = useState<MonitorModeId | null>(null);
  // True when the form was just hydrated from a saved draft, used to show
  // the "Restored from your last draft" banner. Cleared when the user
  // interacts with the form for the first time after hydration, or when
  // they hit "Start over". See PROWL-038 Phase 3.
  const [hydratedFromDraft, setHydratedFromDraft] = useState(false);

  // Timer
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards the background-scan "Scan complete" toast so it fires once per scan
  const toastedRef = useRef(false);

  // Read the monitor from Convex (reactive - updates when scan completes)
  const monitor = useMonitor(activeMonitorId!);

  // After an initial scan is blocked, the monitor flips to status="active"
  // with retryCount > 0 and a nextCheckAt scheduled by the scheduler. We treat
  // this as "still scanning" from the user's perspective so they get continued
  // visual feedback rather than an empty preview while a retry is queued.
  const isInRetry =
    !!monitor && (monitor.retryCount ?? 0) > 0 && monitor.status !== "error";

  // Determine step from state
  const step = !activeMonitorId ? "form" : "scanning";

  // True once the scan has landed the monitor in its normal running state —
  // saveScanResult already made it active before this flips, so this only
  // gates where the user lands, not whether the monitor is live.
  const readyToLand =
    !!activeMonitorId && !isScanning && monitor?.status === "active" && !isInRetry;

  // Elapsed timer during scanning
  const scanInFlight =
    step === "scanning" && (isScanning || monitor?.status === "scanning");

  useEffect(() => {
    if (scanInFlight) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [scanInFlight]);

  const configuredChannels = useConfiguredChannels();

  // Reset (or hydrate from draft) when the sheet opens for a new monitor.
  // Hydration takes precedence over reset so users who navigated away
  // mid-form don't lose their work. See PROWL-038 Phase 3.
  const prevOpenRef = useRef(open);
  const channelsSeededRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current && !activeMonitorId && !isScanning) {
      const draft = readMonitorDraft();
      if (draft) {
        setName(draft.name);
        setUrl(draft.url);
        setPrompt(draft.prompt);
        setCheckInterval(draft.checkInterval);
        setChannels(draft.channels);
        setHydratedFromDraft(true);
        trackMonitorDraftRestored();
        channelsSeededRef.current = true;
      } else {
        resetForm();
        setHydratedFromDraft(false);
      }
    }
    if (!open) channelsSeededRef.current = false;
    prevOpenRef.current = open;
  }, [open, activeMonitorId, isScanning]);

  // Defaults wait for the notification queries. Seeding from an unresolved
  // query offered email-only on a fast open, even with push and Telegram set
  // up — so this completes once they land, and only before the user edits.
  useEffect(() => {
    if (!open || activeMonitorId || isScanning) return;
    if (channelsSeededRef.current || !configuredChannels) return;
    setChannels(defaultChannels(configuredChannels) ?? ["email"]);
    channelsSeededRef.current = true;
  }, [open, activeMonitorId, isScanning, configuredChannels]);

  // A draft carries its own channels, so it is ready the moment it hydrates.
  // Everything else waits, rather than starting a scan on the ["email"] the
  // channels state holds before seeding.
  const channelsReady = hydratedFromDraft || configuredChannels !== undefined;

  // Debounced persistence of the draft. Only writes when the form has
  // some content; the writeMonitorDraft helper short-circuits empty drafts.
  useEffect(() => {
    if (activeMonitorId || isScanning) return;
    if (!open) return;
    const t = setTimeout(() => {
      writeMonitorDraft({ name, url, prompt, checkInterval, channels });
    }, 300);
    return () => clearTimeout(t);
  }, [name, url, prompt, checkInterval, channels, open, activeMonitorId, isScanning]);

  // Pre-populate form when clone defaults are provided
  useEffect(() => {
    if (cloneDefaults && open) {
      setName(cloneDefaults.name);
      setUrl(cloneDefaults.url);
      setPrompt(cloneDefaults.prompt);
      onCloneDefaultsConsumed?.();
    }
  }, [cloneDefaults, open, onCloneDefaultsConsumed]);

  const selectedMode = MONITOR_MODES.find((m) => m.id === mode) ?? null;
  const sessionParams = sessionBoundParams(url);

  function resetForm() {
    setName("");
    setUrl("");
    setPrompt("");
    setCheckInterval("1h");
    setChannels(["email"]);
    setMode(null);
  }

  // Lands the user on the monitor once the scan finishes: navigates straight
  // there if the sheet is open, otherwise flips the floating pill to done and
  // toasts once. Also covers a scheduler retry that succeeds.
  useEffect(() => {
    if (!readyToLand || !activeMonitorId) return;
    const id = activeMonitorId;
    if (open) {
      onConfirm();
      router.push(`/dashboard/monitors/${id}`);
    } else if (!toastedRef.current) {
      toastedRef.current = true;
      toast.success("Scan complete", {
        duration: 10000,
        action: {
          label: "View monitor",
          onClick: () => {
            onConfirm();
            router.push(`/dashboard/monitors/${id}`);
          },
        },
        // onConfirm clears activeMonitorId, which is what retires the pill
        onDismiss: () => onConfirm(),
        onAutoClose: () => onConfirm(),
      });
    }
  }, [readyToLand, open, activeMonitorId, onConfirm, router]);

  // Floating indicator when scanning (or auto-retrying) in background, or
  // once the scan has landed and is waiting to be opened
  const showFloatingIndicator =
    !open && (isScanning || monitor?.status === "scanning" || isInRetry || readyToLand);
  const retryAttempt = monitor?.retryCount ?? 0;

  return (
    <>
      {showFloatingIndicator && (
        <button
          onClick={() => {
            if (readyToLand && activeMonitorId) {
              onConfirm();
              router.push(`/dashboard/monitors/${activeMonitorId}`);
            } else {
              onOpenChange(true);
            }
          }}
          className="fixed bottom-6 right-6 z-50 flex flex-col items-start gap-1 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90 transition-colors animate-in slide-in-from-bottom-4 max-w-xs"
        >
          {readyToLand ? (
            <>
              <span className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" /> Scan complete
              </span>
              <span className="flex items-center gap-1 text-[11px] font-normal opacity-80">
                View monitor <ArrowRight className="h-3 w-3" />
              </span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {isInRetry ? `Retry ${retryAttempt} of 3` : `Scanning... ${elapsed}s`}
              </span>
              {isInRetry && (
                <span className="text-[11px] font-normal opacity-80">
                  The site blocked us — trying again with a proxy
                </span>
              )}
            </>
          )}
        </button>
      )}

      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto p-4 sm:p-6">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                <Radar className="h-4 w-4 text-primary" />
              </div>
              {step === "form" && "New Monitor"}
              {step === "scanning" && (isInRetry ? "Retrying..." : "Scanning...")}
            </SheetTitle>
            <SheetDescription>
              {step === "form" && "Paste a URL and describe what you're looking for."}
              {step === "scanning" && (isInRetry
                ? "The first attempt was blocked — automatically retrying."
                : "AI is scanning the page and extracting data...")}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6">
            {/* ---- STEP 1: FORM ---- */}
            {step === "form" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  // Clear the draft as soon as the scan starts — once we have
                  // an activeMonitorId the form is no longer in a "draft" state.
                  clearMonitorDraft();
                  setHydratedFromDraft(false);
                  // Every scan gets its own completion toast, including one
                  // started from a restored draft (which skips resetForm).
                  toastedRef.current = false;
                  onStartScan({
                    name: name || `Monitor ${new URL(url).hostname}`,
                    url,
                    prompt,
                    checkInterval,
                    notificationChannels: channels,
                  });
                }}
                className="space-y-6"
              >
                {hydratedFromDraft && (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
                    <span className="text-primary">Restored from your last draft</span>
                    <button
                      type="button"
                      onClick={() => {
                        clearMonitorDraft();
                        resetForm();
                        // resetForm drops channels back to ["email"] — let the
                        // seeding effect fill in the configured set again.
                        channelsSeededRef.current = false;
                        setHydratedFromDraft(false);
                        trackMonitorDraftCleared();
                      }}
                      className="text-muted-foreground hover:text-foreground underline"
                    >
                      Start over
                    </button>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="create-name" className="text-sm font-medium">Name</Label>
                  <Input
                    id="create-name"
                    placeholder="e.g. MacBook Pro Refurbished"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="create-url" className="text-sm font-medium">URL to monitor</Label>
                  <Input
                    id="create-url"
                    type="url"
                    placeholder="https://apple.com/shop/refurbished/mac"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    aria-describedby={sessionParams.length > 0 ? "create-url-session-warning" : undefined}
                    required
                  />
                  {sessionParams.length > 0 && (
                    <p id="create-url-session-warning" className="flex gap-1.5 text-xs text-amber-400 leading-relaxed">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>
                        This link includes {new Intl.ListFormat("en").format(sessionParams)}, which{" "}
                        {sessionParams.length === 1 ? "belongs" : "belong"} to your browser session. We
                        won&apos;t be able to open it later. Try the page you reach before any form steps.
                      </span>
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-medium">What are you watching?</Label>
                  <div className="flex flex-wrap gap-2">
                    {MONITOR_MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={mode === m.id}
                        onClick={() => setMode(mode === m.id ? null : m.id)}
                        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                          mode === m.id
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border/40 bg-card/50 text-muted-foreground hover:text-foreground hover:border-primary/20"
                        }`}
                      >
                        <m.icon className="h-3.5 w-3.5" />
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="create-prompt" className="text-sm font-medium">What are you looking for?</Label>
                  <Textarea
                    id="create-prompt"
                    placeholder={selectedMode?.placeholder ?? "e.g. MacBook Pro 14 inch M3 gray under $1500"}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                    required
                  />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {selectedMode?.hint ?? "Describe in plain English. Be as specific as you want."}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Check frequency</Label>
                  <IntervalSelector value={checkInterval} onValueChange={setCheckInterval} />
                </div>
                <ChannelSelector value={channels} onChange={setChannels} monitorId={null} />
                <div className="flex justify-end gap-3 pt-4">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      // Cancel = abandon the draft. The user can always
                      // start fresh next time.
                      clearMonitorDraft();
                      setHydratedFromDraft(false);
                      onOpenChange(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" className="gap-2 shadow-sm shadow-primary/15" disabled={!channelsReady}>
                    {channelsReady ? <Radar className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
                    Scan Page
                  </Button>
                </div>
              </form>
            )}

            {/* ---- STEP 2: SCANNING ---- */}
            {step === "scanning" && (
              <div className="flex flex-col items-center justify-center py-16">
                {monitor?.status === "error" ? (
                  <>
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 mb-6">
                      <AlertTriangle className="h-7 w-7 text-destructive" />
                    </div>
                    <p className="text-lg font-semibold mb-2">Scan failed</p>
                    <p className="text-sm text-muted-foreground text-center max-w-sm mb-6">
                      {monitor.lastError ?? "Unknown error"}
                    </p>
                    <Button variant="destructive" onClick={onCancelScan}>
                      Delete & try again
                    </Button>
                  </>
                ) : isInRetry ? (
                  <>
                    <Loader2 className="h-12 w-12 animate-spin text-primary mb-6" />
                    <p className="text-lg font-semibold mb-1">Retry {retryAttempt} of 3</p>
                    <div className="text-sm text-muted-foreground text-center max-w-sm space-y-1 mb-1">
                      <p>The site blocked the first attempt.</p>
                      <p>
                        We&apos;re trying again automatically with a proxy
                        {retryAttempt >= 2 ? " and a different browser" : ""}.
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground font-mono truncate max-w-sm">
                      {monitor?.url}
                    </p>
                    <p className="text-xs text-muted-foreground mt-4">
                      You can close this panel — we&apos;ll keep retrying in the background.
                    </p>
                  </>
                ) : (
                  <>
                    {/* Real scan progress — two stages that reflect the actual
                        scrape → extract split. See PROWL-039 Part 1. */}
                    {(() => {
                      const hostname = (() => { try { return new URL(monitor?.url ?? "").hostname; } catch { return "page"; } })();
                      const scrapeDone = scanStage !== "idle" && scanStage !== "scraping";
                      return (
                    <div className="w-full max-w-sm space-y-4 py-8">
                      <ScanStep
                        status={scanStage === "scraping" ? "active" : scrapeDone ? "done" : "pending"}
                        label="Scraping page"
                        detail={scanStage === "scraping" ? `Loading ${hostname}` : scrapeDone ? `Loaded from ${hostname}` : undefined}
                        elapsed={scanStage === "scraping" ? elapsed : undefined}
                      />
                      <ScanStep
                        status={scanStage === "extracting" ? "active" : (scanStage === "saving" || scanStage === "done") ? "done" : "pending"}
                        label="AI extracting data"
                        detail={scanStage === "extracting" ? "Reading the page and finding items" : undefined}
                        elapsed={scanStage === "extracting" ? elapsed : undefined}
                      />
                      <ScanStep
                        status={(scanStage === "saving" || scanStage === "done") ? "done" : "pending"}
                        label="Done"
                      />
                    </div>
                      );
                    })()}

                    <p className="text-xs text-muted-foreground">
                      You can close this panel — the scan will continue.
                    </p>

                    {/* While-you-wait suggestions */}
                    <div className="mt-6 w-full max-w-sm space-y-2">
                      <p className="text-xs font-medium text-muted-foreground text-center">While you wait</p>
                      <div className="space-y-1.5">
                        {!configuredChannels?.includes("telegram") && (
                          <button
                            type="button"
                            onClick={() => {
                              onOpenChange(false);
                              router.push("/dashboard/settings?tab=notifications");
                            }}
                            className="w-full flex items-center gap-3 rounded-lg border border-border/30 bg-card/50 px-3 py-2.5 text-left text-xs hover:bg-muted/50 transition-colors"
                          >
                            <MessageCircle className="h-4 w-4 text-muted-foreground shrink-0" />
                            <span>
                              <span className="font-medium text-foreground">Set up Telegram</span>
                              <span className="text-muted-foreground"> — get instant alerts on your phone</span>
                            </span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            onOpenChange(false);
                            router.push("/dashboard/settings?tab=notifications");
                          }}
                          className="w-full flex items-center gap-3 rounded-lg border border-border/30 bg-card/50 px-3 py-2.5 text-left text-xs hover:bg-muted/50 transition-colors"
                        >
                          <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span>
                            <span className="font-medium text-foreground">Send a test email</span>
                            <span className="text-muted-foreground"> — make sure alerts reach your inbox</span>
                          </span>
                        </button>
                      </div>
                    </div>

                    <Button variant="ghost" className="mt-4 text-destructive" onClick={onCancelScan}>
                      Cancel {isInRetry ? "retries" : "scan"}
                    </Button>
                  </>
                )}
              </div>
            )}

          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
