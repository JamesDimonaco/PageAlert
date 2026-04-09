/** Map raw strategy strings to human-readable labels and colors */
export function formatStrategy(strategy?: string): { label: string; color: string } {
  if (!strategy) return { label: "Unknown", color: "bg-muted/50 text-muted-foreground border-border/30" };

  const map: Record<string, { label: string; color: string }> = {
    "quick-check": { label: "Scheduled", color: "bg-muted/50 text-muted-foreground border-border/30" },
    "quick-check+proxy": { label: "Scheduled (proxy)", color: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
    "full-extract": { label: "Full scan", color: "bg-muted/50 text-muted-foreground border-border/30" },
    "full-extract+proxy": { label: "Full scan (proxy)", color: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
    "forced-extract": { label: "Forced extract", color: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
    "forced-extract+proxy": { label: "Retry (proxy + mobile)", color: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
    "manual-rescan": { label: "Manual rescan", color: "bg-primary/10 text-primary border-primary/20" },
  };

  return map[strategy] ?? { label: strategy, color: "bg-muted/50 text-muted-foreground border-border/30" };
}
