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
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Radar,
  Loader2,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import { useScraper } from "@/hooks/use-scraper";
import { MatchConditionsEditor } from "./match-conditions-editor";
import { applyMatchConditions } from "@prowl/shared";
import type { MatchConditions, ExtractedItem, ExtractionSchema } from "@prowl/shared";

type Step = "form" | "scanning" | "preview";
type CheckInterval = "5m" | "15m" | "30m" | "1h" | "6h" | "24h";

interface CreateMonitorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (data: {
    name: string;
    url: string;
    prompt: string;
    checkInterval: CheckInterval;
    schema: ExtractionSchema;
    initialMatchCount: number;
  }) => void;
}

export function CreateMonitorSheet({
  open,
  onOpenChange,
  onCreated,
}: CreateMonitorSheetProps) {
  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [checkInterval, setCheckInterval] = useState<CheckInterval>("1h");

  // Preview state
  const [conditions, setConditions] = useState<MatchConditions>({});
  const [allItems, setAllItems] = useState<ExtractedItem[]>([]);
  const [matches, setMatches] = useState<ExtractedItem[]>([]);
  const [schema, setSchema] = useState<ExtractionSchema | null>(null);

  // Timer for scanning step
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scraper = useScraper();

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

  // Re-apply match conditions when user edits them
  useEffect(() => {
    if (allItems.length > 0) {
      setMatches(applyMatchConditions(allItems, conditions));
    }
  }, [conditions, allItems]);

  function resetForm() {
    setStep("form");
    setName("");
    setUrl("");
    setPrompt("");
    setCheckInterval("1h");
    setConditions({});
    setAllItems([]);
    setMatches([]);
    setSchema(null);
    scraper.reset();
  }

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) {
      scraper.cancel();
      resetForm();
    }
    onOpenChange(newOpen);
  }

  async function handleScan() {
    setStep("scanning");
    const result = await scraper.extract(url, prompt);
    if (result) {
      setSchema(result.schema);
      setAllItems(result.schema.items);
      setConditions(result.schema.matchConditions);
      setMatches(result.matches);
      setStep("preview");
    } else if (scraper.error) {
      // Stay on scanning step to show the error
    }
  }

  function handleConfirm() {
    if (!schema) return;
    // Build the final schema with potentially edited conditions
    const finalSchema: ExtractionSchema = {
      ...schema,
      matchConditions: conditions,
    };
    onCreated({
      name: name || `Monitor ${new URL(url).hostname}`,
      url,
      prompt,
      checkInterval,
      schema: finalSchema,
      initialMatchCount: matches.length,
    });
    resetForm();
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="sm:max-w-2xl overflow-y-auto">
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
            {step === "form" &&
              "Paste a URL and describe what you're looking for."}
            {step === "scanning" &&
              "AI is scanning the page and extracting data..."}
            {step === "preview" &&
              "Review the extracted data and adjust your filters."}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6">
          {/* ---- STEP 1: FORM ---- */}
          {step === "form" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleScan();
              }}
              className="space-y-6"
            >
              <div className="space-y-2">
                <Label htmlFor="create-name" className="text-sm font-medium">
                  Name
                </Label>
                <Input
                  id="create-name"
                  placeholder="e.g. MacBook Pro Refurbished"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="create-url" className="text-sm font-medium">
                  URL to monitor
                </Label>
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
                <Label htmlFor="create-prompt" className="text-sm font-medium">
                  What are you looking for?
                </Label>
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
                <Select
                  value={checkInterval}
                  onValueChange={(v) => v && setCheckInterval(v as CheckInterval)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5m">Every 5 minutes</SelectItem>
                    <SelectItem value="15m">Every 15 minutes</SelectItem>
                    <SelectItem value="30m">Every 30 minutes</SelectItem>
                    <SelectItem value="1h">Every hour</SelectItem>
                    <SelectItem value="6h">Every 6 hours</SelectItem>
                    <SelectItem value="24h">Every 24 hours</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => handleOpenChange(false)}
                >
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
              {scraper.error ? (
                <>
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 mb-6">
                    <AlertTriangle className="h-7 w-7 text-destructive" />
                  </div>
                  <p className="text-lg font-semibold mb-2">Scan failed</p>
                  <p className="text-sm text-muted-foreground text-center max-w-sm mb-6">
                    {scraper.error}
                  </p>
                  <div className="flex gap-3">
                    <Button variant="outline" onClick={() => setStep("form")}>
                      <ArrowLeft className="mr-2 h-4 w-4" />
                      Back
                    </Button>
                    <Button onClick={handleScan}>Try again</Button>
                  </div>
                </>
              ) : (
                <>
                  <Loader2 className="h-12 w-12 animate-spin text-primary mb-6" />
                  <p className="text-lg font-semibold mb-1">
                    Scanning page...
                  </p>
                  <p className="text-sm text-muted-foreground mb-1">
                    {elapsed}s elapsed
                  </p>
                  <p className="text-xs text-muted-foreground font-mono truncate max-w-sm">
                    {url}
                  </p>
                  <Button
                    variant="ghost"
                    className="mt-6"
                    onClick={() => {
                      scraper.cancel();
                      setStep("form");
                    }}
                  >
                    Cancel
                  </Button>
                </>
              )}
            </div>
          )}

          {/* ---- STEP 3: PREVIEW ---- */}
          {step === "preview" && (
            <div className="space-y-6">
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
                    {allItems.length} items found, {matches.length} match{matches.length !== 1 ? "es" : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {matches.length > 0
                      ? "These items match your criteria right now."
                      : "No matches yet. The monitor will notify you when one appears."}
                  </p>
                </div>
              </div>

              {/* Match conditions editor */}
              <div>
                <h3 className="text-sm font-semibold mb-3">Match Filters</h3>
                <p className="text-xs text-muted-foreground mb-4">
                  AI generated these from your prompt. Edit them to fine-tune what you&apos;re looking for.
                </p>
                <MatchConditionsEditor
                  conditions={conditions}
                  onChange={setConditions}
                />
              </div>

              <Separator />

              {/* Items preview */}
              <div>
                <h3 className="text-sm font-semibold mb-3">
                  Extracted Items
                  <Badge variant="outline" className="ml-2 text-xs">
                    {allItems.length}
                  </Badge>
                </h3>
                <div className="max-h-[300px] overflow-y-auto space-y-2 rounded-lg border border-border/30 p-3">
                  {allItems.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No items extracted from the page
                    </p>
                  ) : (
                    allItems.map((item, i) => {
                      const isMatch = matches.some(
                        (m) =>
                          JSON.stringify(m) === JSON.stringify(item)
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

              {/* Actions */}
              <div className="flex justify-between pt-4">
                <Button variant="ghost" onClick={() => setStep("form")}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back
                </Button>
                <Button
                  onClick={handleConfirm}
                  className="gap-2 shadow-sm shadow-primary/15"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Create Monitor
                </Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
