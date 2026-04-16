"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CreateMonitorSheet } from "@/components/prowl/create-monitor-sheet";
import { toast } from "sonner";
import { trackMonitorCreated, trackScanStarted, trackScanCompleted, trackScanFailed } from "@/lib/posthog";

interface CloneDefaults {
  name: string;
  url: string;
  prompt: string;
}

export type ScanStage = "idle" | "scraping" | "extracting" | "saving" | "done";

interface CreateMonitorContextValue {
  open: () => void;
  openWithDefaults: (defaults: CloneDefaults) => void;
  close: () => void;
  resume: (monitorId: Id<"monitors">) => void;
  activeMonitorId: Id<"monitors"> | null;
  isScanning: boolean;
  scanStage: ScanStage;
  isOpen: boolean;
}

const CreateMonitorContext = createContext<CreateMonitorContextValue>({
  open: () => {},
  openWithDefaults: () => {},
  close: () => {},
  resume: () => {},
  activeMonitorId: null,
  isScanning: false,
  scanStage: "idle",
  isOpen: false,
});

export function useCreateMonitor() {
  return useContext(CreateMonitorContext);
}

export function CreateMonitorProvider({ children }: { children: ReactNode }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeMonitorId, setActiveMonitorId] = useState<Id<"monitors"> | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStage, setScanStage] = useState<ScanStage>("idle");
  const [cloneDefaults, setCloneDefaults] = useState<CloneDefaults | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const isSubmittingRef = useRef(false);

  const createMutation = useMutation(api.monitors.create);
  const saveScanResult = useMutation(api.monitors.saveScanResult);
  const saveScanError = useMutation(api.monitors.saveScanError);
  const removeMutation = useMutation(api.monitors.remove);
  const createLog = useMutation(api.logs.create);
  // scanBudget not used here — initial monitor creation doesn't consume rescan quota

  const open = useCallback(() => {
    if (!isScanning) {
      setActiveMonitorId(null);
    }
    setCloneDefaults(null);
    setSheetOpen(true);
  }, [isScanning]);

  const openWithDefaults = useCallback((defaults: CloneDefaults) => {
    if (!isScanning) {
      setActiveMonitorId(null);
    }
    setCloneDefaults(defaults);
    setSheetOpen(true);
  }, [isScanning]);

  const close = useCallback(() => {
    setSheetOpen(false);
  }, []);

  const resume = useCallback((monitorId: Id<"monitors">) => {
    setActiveMonitorId(monitorId);
    setSheetOpen(true);
  }, []);

  const startScan = useCallback(
    async (data: {
      name: string;
      url: string;
      prompt: string;
      checkInterval: "5m" | "15m" | "30m" | "1h" | "6h" | "24h";
      notificationChannels?: ("email" | "telegram" | "discord")[];
    }) => {
      if (isSubmittingRef.current) return;
      isSubmittingRef.current = true;

      let monitorId: Id<"monitors">;
      try {
        monitorId = await createMutation(data);
        trackMonitorCreated({ url: data.url, prompt: data.prompt, checkInterval: data.checkInterval });
      } catch (e) {
        isSubmittingRef.current = false;
        const msg = e instanceof Error ? e.message : "Failed to create monitor";
        toast.error("Failed to create monitor", { description: msg });
        return;
      }

      trackScanStarted({ url: data.url });

      setActiveMonitorId(monitorId);
      setIsScanning(true);
      setScanStage("scraping");

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const startTime = Date.now();

      let alreadyLogged = false;
      try {
        // ---- Stage 1: Scrape the page with Playwright ----
        const scrapeRes = await fetch("/api/scraper/scrape", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: data.url }),
          signal: controller.signal,
        });

        const scrapeJson = await scrapeRes.json();

        if (!scrapeRes.ok) {
          const errorMsg = scrapeJson.message || scrapeJson.error || "Scrape failed";
          const durationMs = Date.now() - startTime;

          await createLog({
            monitorId,
            monitorName: data.name,
            url: data.url,
            prompt: data.prompt,
            status: scrapeRes.status === 502 || scrapeRes.status === 504 ? "timeout" : "error",
            durationMs,
            error: errorMsg,
            rawResponse: JSON.stringify(scrapeJson).slice(0, 10000),
          });
          alreadyLogged = true;

          throw new Error(errorMsg);
        }

        // Check for blocked status from the scraper
        if (scrapeJson.blocked) {
          const errorMsg = `Site is blocking automated access: ${scrapeJson.blockReason ?? "anti-bot protection detected"}`;
          const durationMs = Date.now() - startTime;

          await createLog({
            monitorId,
            monitorName: data.name,
            url: data.url,
            prompt: data.prompt,
            status: "error",
            durationMs,
            error: errorMsg,
          });
          alreadyLogged = true;

          throw new Error(errorMsg);
        }

        // ---- Stage 2: AI extraction ----
        setScanStage("extracting");

        const res = await fetch("/api/scraper/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: data.url,
            prompt: data.prompt,
            name: data.name,
            scrapedText: scrapeJson.text,
          }),
          signal: controller.signal,
        });

        const json = await res.json();
        const durationMs = Date.now() - startTime;

        if (!res.ok) {
          const errorMsg = json.message || json.error || "Extraction failed";

          await createLog({
            monitorId,
            monitorName: data.name,
            url: data.url,
            prompt: data.prompt,
            status: res.status === 502 || res.status === 504 ? "timeout" : "error",
            durationMs,
            error: errorMsg,
            rawResponse: JSON.stringify(json).slice(0, 10000),
          });
          alreadyLogged = true;

          throw new Error(errorMsg);
        }

        // ---- Stage 3: Save results ----
        setScanStage("saving");

        const matchCount = json.matches?.length ?? 0;
        const totalItems = json.totalItems ?? json.schema?.items?.length ?? 0;
        const insights = json.schema?.insights;
        const confidence = insights?.confidence ?? 100;

        // If the AI reports 0% confidence or found no items, the page is likely
        // inaccessible (blocked, access denied, CAPTCHA, etc.)
        if (confidence <= 10 && totalItems === 0) {
          const reason = insights?.notices?.[0] ?? "Page appears inaccessible - no data could be extracted";

          trackScanFailed({ url: data.url, error: reason, durationMs });

          await saveScanError({ id: monitorId, error: reason });

          await createLog({
            monitorId,
            monitorName: data.name,
            url: data.url,
            prompt: data.prompt,
            status: "error",
            durationMs,
            error: reason,
            rawResponse: JSON.stringify(json).slice(0, 50000),
            aiConfidence: confidence,
            aiUnderstanding: insights?.understanding,
            aiNotices: insights?.notices,
          });

          toast.error("Page inaccessible", { description: reason });
          return;
        }

        await saveScanResult({
          id: monitorId,
          schema: json.schema,
          matchCount,
        });

        await createLog({
          monitorId,
          monitorName: data.name,
          url: data.url,
          prompt: data.prompt,
          status: "success",
          durationMs,
          itemCount: totalItems,
          matchCount,
          rawResponse: JSON.stringify(json).slice(0, 50000),
          aiConfidence: insights?.confidence,
          aiUnderstanding: insights?.understanding,
          aiMatchSignal: insights?.matchSignal,
          aiNoMatchSignal: insights?.noMatchSignal,
          aiNotices: insights?.notices,
          matchConditions: json.schema?.matchConditions,
        }).catch(() => {});

        trackScanCompleted({ url: data.url, itemCount: totalItems, matchCount, durationMs, confidence: insights?.confidence });
        // Initial scan — doesn't consume rescan budget

        setScanStage("done");

        toast.success("Scan complete", {
          description: `${totalItems} items found, ${matchCount} match${matchCount !== 1 ? "es" : ""}`,
        });
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        const msg = e instanceof Error ? e.message : "Scan failed";
        const durationMs = Date.now() - startTime;

        trackScanFailed({ url: data.url, error: msg, durationMs });

        await saveScanError({ id: monitorId, error: msg }).catch(() => {});

        if (!alreadyLogged) {
          await createLog({
            monitorId,
            url: data.url,
            prompt: data.prompt,
            status: msg.includes("timed out") || msg.includes("Timeout") || msg.includes("Failed to reach") ? "timeout" : "error",
            durationMs,
            error: msg,
          }).catch(() => {});
        }

        const isBlocked = msg.includes("blocking") || msg.includes("anti-bot") || msg.includes("CAPTCHA") || msg.includes("blocked");
        if (isBlocked) {
          toast("Site blocked initial scan", {
            description: "We'll automatically retry with different strategies (proxy, mobile browser). Check back in a few minutes.",
            duration: 8000,
          });
        } else {
          toast.error("Scan failed", { description: msg });
        }
      } finally {
        setIsScanning(false);
        setScanStage("idle");
        isSubmittingRef.current = false;
      }
    },
    [createMutation, saveScanResult, saveScanError, createLog]
  );

  const cancelScan = useCallback(async () => {
    abortRef.current?.abort();
    if (activeMonitorId) {
      try {
        await removeMutation({ id: activeMonitorId });
      } catch { /* */ }
    }
    setActiveMonitorId(null);
    setIsScanning(false);
    setSheetOpen(false);
  }, [activeMonitorId, removeMutation]);

  const confirmMonitor = useCallback(() => {
    setActiveMonitorId(null);
    setSheetOpen(false);
    toast.success("Monitor is active");
  }, []);

  return (
    <CreateMonitorContext.Provider
      value={{ open, openWithDefaults, close, resume, activeMonitorId, isScanning, scanStage, isOpen: sheetOpen }}
    >
      {children}
      <CreateMonitorSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        activeMonitorId={activeMonitorId}
        isScanning={isScanning}
        scanStage={scanStage}
        onStartScan={startScan}
        onCancelScan={cancelScan}
        onConfirm={confirmMonitor}
        cloneDefaults={cloneDefaults}
        onCloneDefaultsConsumed={() => setCloneDefaults(null)}
      />
    </CreateMonitorContext.Provider>
  );
}
