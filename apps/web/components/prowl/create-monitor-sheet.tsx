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
import { Badge } from "@/components/ui/badge";
import { ChannelSelector } from "@/components/prowl/channel-selector";
import { Separator } from "@/components/ui/separator";
import { IntervalSelector } from "@/components/prowl/interval-selector";
import {
  Radar,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { MatchConditionsEditor } from "./match-conditions-editor";
import { AiInsightsCard } from "./ai-insights";
import { applyMatchConditions } from "@prowl/shared";
import { useMonitor } from "@/hooks/use-monitors";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { MatchConditions, ExtractedItem, ExtractionSchema } from "@prowl/shared";
import { toast } from "sonner";

type CheckInterval = "5m" | "15m" | "30m" | "1h" | "6h" | "24h";

interface CreateMonitorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeMonitorId: Id<"monitors"> | null;
  isScanning: boolean;
  onStartScan: (data: {
    name: string;
    url: string;
    prompt: string;
    checkInterval: CheckInterval;
    notificationChannels?: ("email" | "telegram" | "discord")[];
  }) => void;
  onCancelScan: () => void;
  onConfirm: () => void;
}

export function CreateMonitorSheet({
  open,
  onOpenChange,
  activeMonitorId,
  isScanning,
  onStartScan,
  onCancelScan,
  onConfirm,
}: CreateMonitorSheetProps) {
  // Form state (only used before scan starts)
  const router = useRouter();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [checkInterval, setCheckInterval] = useState<CheckInterval>("6h");
  const [channels, setChannels] = useState<("email" | "telegram" | "discord")[]>(["email"]);

  // Match conditions editing
  const [editedConditions, setEditedConditions] = useState<MatchConditions | null>(null);

  // Timer
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Read the monitor from Convex (reactive - updates when scan completes)
  const monitor = useMonitor(activeMonitorId!);

  // Determine step from state
  const step = !activeMonitorId
    ? "form"
    : (isScanning || monitor?.status === "scanning" || monitor?.status === "error")
      ? "scanning"
      : "preview";

  // Elapsed timer during scanning
  useEffect(() => {
    if (step === "scanning") {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [step]);

  // Default channels to all configured channels
  const notifSettings = useQuery(api.notificationSettings.list);

  // Reset form when the sheet opens for a new monitor (false → true transition)
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (open && !prevOpenRef.current && !activeMonitorId && !isScanning) {
      resetForm();
      // Set default channels to all configured ones
      const configured: ("email" | "telegram" | "discord")[] = ["email"];
      if (notifSettings) {
        for (const s of notifSettings) {
          if (s.enabled && (s.channel === "telegram" || s.channel === "discord")) {
            configured.push(s.channel);
          }
        }
      }
      setChannels(configured);
    }
    prevOpenRef.current = open;
  }, [open, activeMonitorId, isScanning, notifSettings]);

  // When monitor loads with schema, init edited conditions
  useEffect(() => {
    if (monitor?.schema?.matchConditions && !editedConditions) {
      setEditedConditions(monitor.schema.matchConditions);
    }
  }, [monitor?.schema, editedConditions]);

  const schema = monitor?.schema as ExtractionSchema | undefined;
  const allItems = (schema?.items ?? []) as ExtractedItem[];
  const conditions = editedConditions ?? schema?.matchConditions ?? {};
  const matches = allItems.length > 0 ? applyMatchConditions(allItems, conditions) : [];

  const updateMutation = useMutation(api.monitors.update);

  function resetForm() {
    setName("");
    setUrl("");
    setPrompt("");
    setCheckInterval("6h");
    setChannels(["email"]);
    setEditedConditions(null);
  }

  async function handleConfirm() {
    // Save edited conditions back to the monitor if changed
    try {
      if (activeMonitorId && editedConditions && schema) {
        await updateMutation({
          id: activeMonitorId,
          schema: { ...schema, matchConditions: editedConditions },
        });
      }
      resetForm();
      onConfirm();
    } catch {
      toast.error("Failed to save filter changes");
    }
  }

  // Floating indicator when scanning in background
  const showFloatingIndicator = !open && (isScanning || monitor?.status === "scanning");

  return (
    <>
      {showFloatingIndicator && (
        <button
          onClick={() => onOpenChange(true)}
          className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90 transition-colors animate-in slide-in-from-bottom-4"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Scanning... {elapsed}s
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
              {step === "scanning" && "Scanning..."}
              {step === "preview" && "Review Results"}
            </SheetTitle>
            <SheetDescription>
              {step === "form" && "Paste a URL and describe what you're looking for."}
              {step === "scanning" && "AI is scanning the page and extracting data..."}
              {step === "preview" && "Review the extracted data and adjust your filters."}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6">
            {/* ---- STEP 1: FORM ---- */}
            {step === "form" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
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
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="create-prompt" className="text-sm font-medium">What are you looking for?</Label>
                  <Textarea
                    id="create-prompt"
                    placeholder="e.g. MacBook Pro 14 inch M3 gray under $1500"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                    required
                  />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Describe in plain English. Be as specific as you want.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Check frequency</Label>
                  <IntervalSelector value={checkInterval} onValueChange={setCheckInterval} />
                </div>
                <ChannelSelector value={channels} onChange={setChannels} monitorId={null} />
                <div className="flex justify-end gap-3 pt-4">
                  <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" className="gap-2 shadow-sm shadow-primary/15">
                    <Radar className="h-4 w-4" />
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
                ) : (
                  <>
                    <Loader2 className="h-12 w-12 animate-spin text-primary mb-6" />
                    <p className="text-lg font-semibold mb-1">Scanning page...</p>
                    <p className="text-sm text-muted-foreground mb-1">{elapsed}s elapsed</p>
                    <p className="text-xs text-muted-foreground font-mono truncate max-w-sm">
                      {monitor?.url}
                    </p>
                    <p className="text-xs text-muted-foreground mt-4">
                      You can close this panel — the scan will continue.
                    </p>
                    <Button variant="ghost" className="mt-4 text-destructive" onClick={onCancelScan}>
                      Cancel scan
                    </Button>
                  </>
                )}
              </div>
            )}

            {/* ---- STEP 3: PREVIEW ---- */}
            {step === "preview" && monitor && (
              <div className="space-y-6">
                {/* AI Insights */}
                {schema?.insights && <AiInsightsCard insights={schema.insights} />}

                {/* Summary */}
                <div className="flex items-center gap-4 rounded-lg bg-card/80 p-4 border border-border/30">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 shrink-0">
                    {matches.length > 0 ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                    ) : (
                      <XCircle className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-semibold">
                      {allItems.length} items found, {matches.length} match
                      {matches.length !== 1 ? "es" : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {matches.length > 0
                        ? "These items match your criteria right now."
                        : "No matches yet. The monitor will notify you when one appears."}
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-3">Match Filters</h3>
                  <p className="text-xs text-muted-foreground mb-4">
                    AI generated these from your prompt. Edit them to fine-tune what you&apos;re looking for.
                  </p>
                  <MatchConditionsEditor
                    conditions={conditions}
                    onChange={setEditedConditions}
                  />
                </div>

                <Separator />

                <div>
                  <h3 className="text-sm font-semibold mb-3">
                    Extracted Items
                    <Badge variant="outline" className="ml-2 text-xs">{allItems.length}</Badge>
                  </h3>
                  <div className="max-h-[300px] overflow-y-auto space-y-2 rounded-lg border border-border/30 p-3">
                    {allItems.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No items extracted from the page
                      </p>
                    ) : (
                      allItems.map((item, i) => {
                        const isMatch = matches.some(
                          (m) => JSON.stringify(m) === JSON.stringify(item)
                        );
                        return (
                          <div
                            key={i}
                            className={`rounded-lg p-3 text-sm transition-colors ${
                              isMatch
                                ? "bg-emerald-500/5 border border-emerald-500/20"
                                : "bg-background/50 border border-transparent opacity-60"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex-1 min-w-0">
                                <p className="font-medium truncate">
                                  {String(item.title ?? item.name ?? `Item ${i + 1}`)}
                                </p>
                                {item.price != null && (
                                  <p className="text-xs text-muted-foreground mt-0.5">
                                    ${Number(item.price).toLocaleString()}
                                    {item.originalPrice != null && (
                                      <span className="line-through ml-2">
                                        ${Number(item.originalPrice).toLocaleString()}
                                      </span>
                                    )}
                                  </p>
                                )}
                              </div>
                              {isMatch && (
                                <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs shrink-0">
                                  Match
                                </Badge>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 pt-4">
                  <Button variant="outline" onClick={handleConfirm} className="gap-2 w-full sm:w-auto">
                    <CheckCircle2 className="h-4 w-4" />
                    Looks Good
                  </Button>
                  <Button
                    onClick={async () => {
                      await handleConfirm();
                      if (activeMonitorId) {
                        router.push(`/dashboard/monitors/${activeMonitorId}`);
                      }
                    }}
                    className="gap-2 shadow-sm shadow-primary/15 w-full sm:w-auto"
                  >
                    View Details
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
