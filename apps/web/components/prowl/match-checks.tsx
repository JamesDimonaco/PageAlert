"use client";

import { CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ExtractedItem, MatchCheck, MatchConditions } from "@prowl/shared";
import { explainMatch } from "@prowl/shared";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

function conditionLabel(check: MatchCheck, currency: unknown): string {
  switch (check.kind) {
    case "price": {
      const min = check.min ? formatPrice(check.min, currency) : null;
      const max = check.max !== undefined ? formatPrice(check.max, currency) : null;
      if (min && max) return `Price between ${min} and ${max}`;
      if (max) return `Price ${max} or less`;
      if (min) return `Price ${min} or more`;
      return "Shows a price";
    }
    case "titleContains":
      return `Name includes “${check.word}”`;
    case "titleExcludes":
      return `Name doesn't include “${check.word}”`;
    case "mustInclude":
      return `Mentions “${check.word}”`;
    case "mustExclude":
      return `Doesn't mention “${check.word}”`;
  }
}

/** What the one item on a product page shows for this condition. */
function singleItemDetail(check: MatchCheck, currency: unknown): string | null {
  if (check.kind !== "price") return null;
  return check.price === undefined ? "no price found" : `now ${formatPrice(check.price, currency)}`;
}

/**
 * The conditions an item has to pass to count as a match, each with a tick or
 * a cross. On a product page it shows the product's own value ("now NZ$379");
 * on a listing, how many items pass that one condition.
 */
export function MatchChecks({
  items,
  conditions,
  showStockHint,
  onOpenSettings,
}: {
  items: ExtractedItem[];
  conditions: MatchConditions;
  /** A product monitor with no back-in-stock alert: stock is not being checked at all. */
  showStockHint: boolean;
  onOpenSettings: () => void;
}) {
  if (items.length === 0) return null;
  // Every item gets the same conditions in the same order, so row i lines up across items.
  const perItem = items.map((item) => explainMatch(item, conditions));
  const rows = perItem[0];
  const currency = items.find((item) => typeof item.currency === "string")?.currency;
  const single = items.length === 1;

  if (rows.length === 0 && !showStockHint) return null;

  return (
    <div className="mb-3 rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-sm font-medium">To count as a match, {single ? "it needs" : "an item needs"}:</p>
      <ul className="mt-2 space-y-1.5">
        {rows.map((check, i) => {
          const passing = perItem.filter((checks) => checks[i].pass).length;
          const pass = single ? check.pass : passing > 0;
          const detail = single ? singleItemDetail(check, currency) : `${passing} of ${items.length} items`;
          const Icon = pass ? CheckCircle2 : XCircle;
          return (
            <li key={i} className="flex items-center gap-2 text-sm">
              <Icon className={cn("h-4 w-4 shrink-0", pass ? "text-emerald-400" : "text-red-400")} />
              <span>{conditionLabel(check, currency)}</span>
              {detail && (
                <span className={cn("tabular-nums", pass ? "text-muted-foreground" : "text-red-400")}>
                  · {detail}
                </span>
              )}
              <span className="sr-only">{pass ? "(passes)" : "(fails)"}</span>
            </li>
          );
        })}
        {showStockHint && (
          <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <CircleHelp className="h-4 w-4 shrink-0" />
            <span>Stock isn&apos;t checked.</span>
            <Button variant="link" size="sm" className="h-auto p-0" onClick={onOpenSettings}>
              Alert me when it&apos;s back in stock
            </Button>
          </li>
        )}
      </ul>
    </div>
  );
}
