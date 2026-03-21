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
  /** Open the create monitor sheet */
  open: () => void;
  /** Resume viewing a scanning/completed monitor */
  resume: (monitorId: Id<"monitors">) => void;
  /** The monitor ID currently being created/scanned */
  activeMonitorId: Id<"monitors"> | null;
  /** Whether a scan is in progress */
  isScanning: boolean;
  /** Whether the sheet is open */
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

  const createMutation = useMutation(api.monitors.create);
  const saveScanResult = useMutation(api.monitors.saveScanResult);
  const saveScanError = useMutation(api.monitors.saveScanError);
  const removeMutation = useMutation(api.monitors.remove);

  const open = useCallback(() => {
    // Only open fresh if not already scanning
    if (!isScanning) {
      setActiveMonitorId(null);
    }
    setSheetOpen(true);
  }, [isScanning]);

  const resume = useCallback((monitorId: Id<"monitors">) => {
    setActiveMonitorId(monitorId);
    setSheetOpen(true);
  }, []);

  /** Called by the sheet when user submits the form. Creates monitor and starts scan. */
  const startScan = useCallback(
    async (data: {
      name: string;
      url: string;
      prompt: string;
      checkInterval: "5m" | "15m" | "30m" | "1h" | "6h" | "24h";
    }) => {
      // 1. Create monitor in DB immediately with status "scanning"
      const monitorId = await createMutation(data);
      setActiveMonitorId(monitorId);
      setIsScanning(true);

      // 2. Fire off the scan in the background
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/scraper/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: data.url, prompt: data.prompt }),
          signal: controller.signal,
        });

        const json = await res.json();

        if (!res.ok) {
          throw new Error(json.error || json.message || "Extraction failed");
        }

        // 3. Save results to DB
        const matchCount = json.matches?.length ?? 0;
        await saveScanResult({
          id: monitorId,
          schema: json.schema,
          matchCount,
        });

        toast.success("Scan complete", {
          description: `${json.totalItems} items found, ${matchCount} match${matchCount !== 1 ? "es" : ""}`,
        });
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        const msg = e instanceof Error ? e.message : "Scan failed";
        await saveScanError({ id: monitorId, error: msg });
        toast.error("Scan failed", { description: msg });
      } finally {
        setIsScanning(false);
      }
    },
    [createMutation, saveScanResult, saveScanError]
  );

  /** Cancel the active scan and delete the monitor */
  const cancelScan = useCallback(async () => {
    abortRef.current?.abort();
    if (activeMonitorId) {
      try {
        await removeMutation({ id: activeMonitorId });
      } catch {
        // Monitor might already be gone
      }
    }
    setActiveMonitorId(null);
    setIsScanning(false);
    setSheetOpen(false);
  }, [activeMonitorId, removeMutation]);

  /** User confirmed the monitor (after reviewing results). Just close the sheet. */
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
