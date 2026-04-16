"use client";

import { Check, Loader2 } from "lucide-react";

interface ScanStepProps {
  status: "pending" | "active" | "done";
  label: string;
  detail?: string;
  elapsed?: number;
}

/**
 * A single step in the scan progress indicator. Three states:
 * - pending: muted, empty circle
 * - active: pulsing spinner, elapsed timer
 * - done: green checkmark, duration
 *
 * See PROWL-039 Part 1.
 */
export function ScanStep({ status, label, detail, elapsed }: ScanStepProps) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0">
        {status === "done" && (
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10">
            <Check className="h-3 w-3 text-emerald-400" />
          </div>
        )}
        {status === "active" && (
          <div className="flex h-5 w-5 items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          </div>
        )}
        {status === "pending" && (
          <div className="flex h-5 w-5 items-center justify-center">
            <div className="h-2 w-2 rounded-full bg-muted-foreground/30" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p
            className={`text-sm ${
              status === "active"
                ? "font-semibold text-foreground"
                : status === "done"
                  ? "font-medium text-emerald-400"
                  : "text-muted-foreground"
            }`}
          >
            {label}
          </p>
          {elapsed != null && (
            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
              {elapsed}s
            </span>
          )}
        </div>
        {detail && (
          <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>
        )}
      </div>
    </div>
  );
}
