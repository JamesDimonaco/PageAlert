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

interface CreateMonitorContextValue {
  open: () => void;
  resume: (monitorId: Id<"monitors">) => void;
  activeMonitorId: Id<"monitors"> | null;
  isScanning: boolean;
  isOpen: boolean;
}

const CreateMonitorContext = createContext<CreateMonitorContextValue>({
  open: () => {},
  resume: () => {},
  activeMonitorId: null,
  isScanning: false,
  isOpen: false,
});

export function useCreateMonitor() {
  return useContext(CreateMonitorContext);
}

export function CreateMonitorProvider({ children }: { children: ReactNode }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeMonitorId, setActiveMonitorId] = useState<Id<"monitors"> | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const isSubmittingRef = useRef(false);

  const createMutation = useMutation(api.monitors.create);
  const saveScanResult = useMutation(api.monitors.saveScanResult);
  const saveScanError = useMutation(api.monitors.saveScanError);
  const removeMutation = useMutation(api.monitors.remove);
  const createLog = useMutation(api.logs.create);

  const open = useCallback(() => {
    if (!isScanning) {
      setActiveMonitorId(null);
    }
    setSheetOpen(true);
  }, [isScanning]);

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
    }) => {
      if (isSubmittingRef.current) return;
      isSubmittingRef.current = true;

      let monitorId: Id<"monitors">;
      try {
        monitorId = await createMutation(data);
      } catch (e) {
        isSubmittingRef.current = false;
        const msg = e instanceof Error ? e.message : "Failed to create monitor";
        toast.error("Failed to create monitor", { description: msg });
        return;
      }

      setActiveMonitorId(monitorId);
      setIsScanning(true);

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const startTime = Date.now();

      try {
        const res = await fetch("/api/scraper/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: data.url, prompt: data.prompt, name: data.name }),
          signal: controller.signal,
        });

        const json = await res.json();
        const durationMs = Date.now() - startTime;

        if (!res.ok) {
          const errorMsg = json.error || json.message || "Extraction failed";

          // Log the error
          await createLog({
            monitorId,
            url: data.url,
            prompt: data.prompt,
            status: res.status === 502 || res.status === 504 ? "timeout" : "error",
            durationMs,
            error: errorMsg,
            rawResponse: JSON.stringify(json).slice(0, 10000),
          });

          throw new Error(errorMsg);
        }

        // Success - save results and log
        const matchCount = json.matches?.length ?? 0;
        const totalItems = json.totalItems ?? json.schema?.items?.length ?? 0;

        await saveScanResult({
          id: monitorId,
          schema: json.schema,
          matchCount,
        });

        await createLog({
          monitorId,
          url: data.url,
          prompt: data.prompt,
          status: "success",
          durationMs,
          itemCount: totalItems,
          matchCount,
          rawResponse: JSON.stringify(json).slice(0, 50000),
        });

        toast.success("Scan complete", {
          description: `${totalItems} items found, ${matchCount} match${matchCount !== 1 ? "es" : ""}`,
        });
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        const msg = e instanceof Error ? e.message : "Scan failed";
        const durationMs = Date.now() - startTime;

        await saveScanError({ id: monitorId, error: msg }).catch(() => {});

        // Always log failures
        await createLog({
          monitorId,
          url: data.url,
          prompt: data.prompt,
          status: msg.includes("timed out") || msg.includes("Timeout") || msg.includes("Failed to reach") ? "timeout" : "error",
          durationMs,
          error: msg,
        }).catch(() => {});

        toast.error("Scan failed", { description: msg });
      } finally {
        setIsScanning(false);
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
      value={{ open, resume, activeMonitorId, isScanning, isOpen: sheetOpen }}
    >
      {children}
      <CreateMonitorSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        activeMonitorId={activeMonitorId}
        isScanning={isScanning}
        onStartScan={startScan}
        onCancelScan={cancelScan}
        onConfirm={confirmMonitor}
      />
    </CreateMonitorContext.Provider>
  );
}
