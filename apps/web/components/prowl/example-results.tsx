import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, ExternalLink, TrendingDown, Zap, Clock } from "lucide-react";

const EXAMPLE_ITEMS = [
  { title: "MacBook Pro 14\" M3 Pro — Refurbished", price: "$1,399", matched: true, url: "#" },
  { title: "MacBook Pro 16\" M3 Max — Refurbished", price: "$2,149", matched: false, url: "#" },
  { title: "MacBook Pro 14\" M3 — Refurbished", price: "$1,099", matched: true, url: "#" },
  { title: "MacBook Pro 16\" M3 Pro — Refurbished", price: "$1,899", matched: false, url: "#" },
  { title: "MacBook Pro 14\" M3 Pro 18GB — Refurbished", price: "$1,479", matched: true, url: "#" },
];

export function ExampleResults() {
  return (
    <section className="border-t border-border/30 bg-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-28">
        <div className="mx-auto max-w-2xl text-center mb-12 sm:mb-16">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight leading-tight">
            See what PageAlert finds
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            Here&apos;s what a real scan looks like — AI extracts items, matches your criteria, and tracks changes over time
          </p>
        </div>

        <div className="mx-auto max-w-4xl">
          {/* Mock scan result card */}
          <div className="rounded-xl border border-border/30 bg-card/50 shadow-lg shadow-black/5 overflow-hidden">
            {/* Header */}
            <div className="border-b border-border/20 px-5 sm:px-8 py-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-lg font-bold">MacBook Pro Refurbished</h3>
                    <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">3 matches</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Looking for: &ldquo;MacBook Pro under $1500&rdquo;
                  </p>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Zap className="h-3.5 w-3.5 text-primary" />
                    92% confidence
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    12s scan
                  </span>
                </div>
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 border-b border-border/20">
              <div className="px-5 sm:px-8 py-4 text-center border-r border-border/20">
                <p className="text-2xl font-bold">5</p>
                <p className="text-xs text-muted-foreground">Items found</p>
              </div>
              <div className="px-5 sm:px-8 py-4 text-center border-r border-border/20">
                <p className="text-2xl font-bold text-primary">3</p>
                <p className="text-xs text-muted-foreground">Matches</p>
              </div>
              <div className="px-5 sm:px-8 py-4 text-center">
                <p className="text-2xl font-bold flex items-center justify-center gap-1">
                  <TrendingDown className="h-5 w-5 text-emerald-400" />
                  2
                </p>
                <p className="text-xs text-muted-foreground">Price drops</p>
              </div>
            </div>

            {/* Items */}
            <div className="px-5 sm:px-8 py-5 space-y-2">
              {EXAMPLE_ITEMS.map((item, i) => (
                <div
                  key={i}
                  className={`flex items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm ${
                    item.matched
                      ? "bg-emerald-500/5 border border-emerald-500/15"
                      : "bg-muted/30 border border-transparent"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {item.matched && <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />}
                    <span className={`truncate ${item.matched ? "font-medium" : "text-muted-foreground"}`}>
                      {item.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`font-bold ${item.matched ? "text-emerald-400" : ""}`}>{item.price}</span>
                    <ExternalLink className="h-3 w-3 text-muted-foreground/50" />
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="border-t border-border/20 px-5 sm:px-8 py-4 bg-muted/20">
              <p className="text-xs text-muted-foreground text-center">
                This is an example of what PageAlert extracts from a real website — try it yourself above
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
