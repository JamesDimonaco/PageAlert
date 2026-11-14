const DEFAULT_STYLE = "bg-muted/50 text-muted-foreground border-border/30";

const STRATEGY_MAP: Record<string, { label: string; color: string }> = {
  "quick-check": { label: "Scheduled", color: DEFAULT_STYLE },
  "quick-check+proxy": { label: "Scheduled (proxy)", color: "bg-blue-500/10 text-info border-blue-500/20" },
  "full-extract": { label: "Full scan", color: DEFAULT_STYLE },
  "full-extract+proxy": { label: "Full scan (proxy)", color: "bg-blue-500/10 text-info border-blue-500/20" },
  "forced-extract": { label: "Forced extract", color: "bg-amber-500/10 text-warning border-amber-500/20" },
  "forced-extract+proxy": { label: "Retry (proxy + mobile)", color: "bg-amber-500/10 text-warning border-amber-500/20" },
  "manual-rescan": { label: "Manual rescan", color: "bg-primary/10 text-primary border-primary/20" },
};

/** Map raw strategy strings to human-readable labels and colors */
export function formatStrategy(strategy?: string): { label: string; color: string } {
  if (!strategy) return { label: "Unknown", color: DEFAULT_STYLE };
  return STRATEGY_MAP[strategy] ?? { label: strategy, color: DEFAULT_STYLE };
}
