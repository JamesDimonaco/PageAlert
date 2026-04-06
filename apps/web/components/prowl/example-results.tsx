import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, TrendingDown, Zap, Clock, ArrowRight } from "lucide-react";
import Link from "next/link";
import { EXAMPLE_ITEMS, EXAMPLE_MATCHES, EXAMPLE_PRICE_DROPS } from "@/lib/example-data";

export function ExampleResults() {
  const teaser = EXAMPLE_ITEMS.slice(0, 5);

  return (
    <div className="mx-auto mt-16 sm:mt-20 max-w-4xl">
      <div className="text-center mb-8">
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight">
          See what PageAlert finds
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Here&apos;s a real example — AI extracts items, highlights matches, and tracks price changes
        </p>
      </div>

      <div className="rounded-xl border border-border/30 bg-card/50 shadow-lg shadow-black/5 overflow-hidden">
        {/* Header */}
        <div className="border-b border-border/20 px-4 sm:px-6 py-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="font-bold">MacBook Pro Refurbished</h3>
                <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">{EXAMPLE_MATCHES} matches</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                &ldquo;MacBook Pro under $1500&rdquo;
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Zap className="h-3 w-3 text-primary" />
                92%
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                12s
              </span>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 border-b border-border/20 text-center">
          <div className="py-3 border-r border-border/20">
            <p className="text-lg font-bold">{teaser.length}</p>
            <p className="text-[10px] text-muted-foreground">Items</p>
          </div>
          <div className="py-3 border-r border-border/20">
            <p className="text-lg font-bold text-primary">{teaser.filter((i) => i.matched).length}</p>
            <p className="text-[10px] text-muted-foreground">Matches</p>
          </div>
          <div className="py-3">
            <p className="text-lg font-bold flex items-center justify-center gap-1">
              <TrendingDown className="h-4 w-4 text-emerald-400" />{EXAMPLE_PRICE_DROPS}
            </p>
            <p className="text-[10px] text-muted-foreground">Price drops</p>
          </div>
        </div>

        {/* Items */}
        <div className="px-4 sm:px-6 py-4 space-y-1.5">
          {teaser.map((item, i) => (
            <div
              key={i}
              className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm ${
                item.matched
                  ? "bg-emerald-500/5 border border-emerald-500/15"
                  : "bg-muted/20"
              }`}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {item.matched && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />}
                <span className={`truncate text-xs sm:text-sm ${item.matched ? "font-medium" : "text-muted-foreground"}`}>
                  {item.title}
                </span>
              </div>
              <span className={`text-xs sm:text-sm font-bold shrink-0 ${item.matched ? "text-emerald-400" : ""}`}>
                ${item.price.toLocaleString()}
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-border/20 px-4 sm:px-6 py-3 bg-muted/20 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Example results from a real scan
          </p>
          <Link
            href="/try/example"
            className="text-xs text-primary hover:underline font-medium flex items-center gap-1"
          >
            See full example
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </div>
  );
}
