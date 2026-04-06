import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Radar,
  CheckCircle2,
  TrendingDown,
  Zap,
  Clock,
  ArrowRight,
  History,
  Quote,
} from "lucide-react";
import Link from "next/link";
import { EXAMPLE_ITEMS, EXAMPLE_MATCHES, EXAMPLE_PRICE_DROPS, EXAMPLE_HISTORY } from "@/lib/example-data";

export const metadata: Metadata = {
  title: "Example Scan Results",
  description: "See what PageAlert finds when monitoring a website. AI-powered extraction with matches, price tracking, and change detection.",
};

const ITEMS = EXAMPLE_ITEMS;
const HISTORY = EXAMPLE_HISTORY;

export default function ExamplePage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/30 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Radar className="h-5 w-5 text-primary" />
            </div>
            <span className="text-xl font-bold tracking-tight">PageAlert</span>
          </Link>
          <Badge variant="outline" className="text-xs">Example results</Badge>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 sm:px-6 py-8 sm:py-12 space-y-8">
        {/* Monitor header */}
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">MacBook Pro Refurbished</h1>
            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">Active</Badge>
          </div>
          <p className="text-sm text-muted-foreground break-all">
            apple.com/shop/refurbished/mac/macbook-pro
          </p>
          <div className="flex items-start gap-3 mt-4">
            <Quote className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <p className="text-sm font-medium">MacBook Pro under $1,500</p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="border-border/30 bg-card/50">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Items</p>
              <p className="text-2xl font-bold">7</p>
            </CardContent>
          </Card>
          <Card className="border-emerald-500/20 bg-emerald-500/5">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Matches</p>
              <p className="text-2xl font-bold text-emerald-400">{EXAMPLE_MATCHES}</p>
            </CardContent>
          </Card>
          <Card className="border-border/30 bg-card/50">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Checks</p>
              <p className="text-2xl font-bold">47</p>
            </CardContent>
          </Card>
          <Card className="border-border/30 bg-card/50">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">AI Confidence</p>
              <p className="text-2xl font-bold text-emerald-400">92%</p>
            </CardContent>
          </Card>
        </div>

        {/* Matched items */}
        <div>
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            Matched Items
            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">{EXAMPLE_MATCHES}</Badge>
          </h2>
          <div className="space-y-2">
            {ITEMS.filter((i) => i.matched).map((item, i) => (
              <Card key={i} className="border-emerald-500/20 bg-emerald-500/5">
                <CardContent className="p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      <span className="text-sm font-medium truncate">{item.title}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {item.oldPrice && (
                        <span className="text-xs text-muted-foreground line-through">${item.oldPrice.toLocaleString()}</span>
                      )}
                      <span className="text-sm font-bold">${item.price.toLocaleString()}</span>
                      {item.oldPrice && (
                        <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px] gap-0.5">
                          <TrendingDown className="h-3 w-3" />
                          {Math.round(((item.oldPrice - item.price) / item.oldPrice) * 100)}% off
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        {/* All items */}
        <div>
          <h2 className="text-sm font-semibold mb-3">Other Items ({ITEMS.filter((i) => !i.matched).length})</h2>
          <div className="space-y-2">
            {ITEMS.filter((i) => !i.matched).map((item, i) => (
              <Card key={i} className="border-border/30 bg-card/30">
                <CardContent className="p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <span className="text-sm text-muted-foreground truncate">{item.title}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {item.oldPrice && (
                        <span className="text-xs text-muted-foreground line-through">${item.oldPrice.toLocaleString()}</span>
                      )}
                      <span className="text-sm font-medium">${item.price.toLocaleString()}</span>
                      {item.oldPrice && (
                        <Badge variant="outline" className="text-[10px] gap-0.5">
                          <TrendingDown className="h-3 w-3" />
                          {Math.round(((item.oldPrice - item.price) / item.oldPrice) * 100)}%
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        {/* History timeline */}
        <div>
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            Recent Activity
          </h2>
          <div className="space-y-3">
            {HISTORY.map((h, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className={`mt-1 h-2 w-2 rounded-full shrink-0 ${
                  h.type === "price" ? "bg-emerald-400" : h.type === "match" ? "bg-primary" : h.type === "new" ? "bg-blue-400" : "bg-muted-foreground/30"
                }`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{h.event}</p>
                    <span className="text-xs text-muted-foreground">{h.time}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{h.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <Card className="border-primary/30 bg-primary/5 shadow-md">
          <CardContent className="p-6 text-center">
            <Zap className="h-8 w-8 text-primary mx-auto mb-3" />
            <h3 className="text-lg font-bold mb-1">This is what your monitors look like</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Try it yourself — paste any URL and describe what you&apos;re looking for. No account needed.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Try it free
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-6 py-2.5 text-sm font-medium hover:bg-muted transition-colors"
              >
                Create account
              </Link>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
