"use client";

import { Info } from "lucide-react";
import type { AiInsights } from "@prowl/shared";

export function AiInsightsCard({ insights }: { insights: AiInsights }) {
  return (
    <div className="space-y-4 text-sm">
      <p className="leading-relaxed text-muted-foreground">{insights.understanding}</p>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="mb-1 font-medium text-foreground">Counts as a match</dt>
          <dd className="leading-relaxed text-muted-foreground">{insights.matchSignal}</dd>
        </div>
        <div>
          <dt className="mb-1 font-medium text-foreground">Doesn&apos;t count</dt>
          <dd className="leading-relaxed text-muted-foreground">{insights.noMatchSignal}</dd>
        </div>
      </dl>
      {insights.notices.length > 0 && (
        <ul className="space-y-1.5">
          {insights.notices.map((n, i) => (
            <li key={i} className="flex items-start gap-2 text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span className="leading-relaxed">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
