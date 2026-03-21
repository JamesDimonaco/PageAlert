"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function useMonitors() {
  const monitors = useQuery(api.monitors.list) ?? [];

  const createMutation = useMutation(api.monitors.create);
  const updateMutation = useMutation(api.monitors.update);
  const removeMutation = useMutation(api.monitors.remove);

  const createMonitor = (data: {
    name: string;
    url: string;
    prompt: string;
    checkInterval: "5m" | "15m" | "30m" | "1h" | "6h" | "24h";
    schema?: unknown;
    initialMatchCount?: number;
  }) => createMutation(data);

  const updateMonitor = (
    id: Id<"monitors">,
    data: {
      name?: string;
      url?: string;
      prompt?: string;
      status?: "active" | "paused" | "error" | "matched";
      checkInterval?: "5m" | "15m" | "30m" | "1h" | "6h" | "24h";
    }
  ) => updateMutation({ id, ...data });

  const deleteMonitor = (id: Id<"monitors">) => removeMutation({ id });

  const togglePause = (id: Id<"monitors">) => {
    const monitor = monitors.find((m) => m._id === id);
    if (monitor) {
      updateMutation({
        id,
        status: monitor.status === "paused" ? "active" : "paused",
      });
    }
  };

  return { monitors, createMonitor, updateMonitor, deleteMonitor, togglePause };
}

export function useMonitor(id: Id<"monitors">) {
  return useQuery(api.monitors.get, { id });
}

export function useMonitorResults(monitorId: Id<"monitors">) {
  return useQuery(api.monitors.getResults, { monitorId }) ?? [];
}
