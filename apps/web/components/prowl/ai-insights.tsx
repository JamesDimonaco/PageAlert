"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Brain, Target, EyeOff, Info } from "lucide-react";
import type { AiInsights } from "@prowl/shared";

function confidenceColor(confidence: number): string {
  if (confidence >= 80) return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
  if (confidence >= 50) return "bg-amber-500/10 text-amber-400 border-amber-500/20";
  return "bg-red-500/10 text-red-400 border-red-500/20";
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 80) return "High confidence";
  if (confidence >= 50) return "Medium confidence";
  return "Low confidence";
}

export function AiInsightsCard({ insights }: { insights: AiInsights }) {
  return (
    <div className="space-y-4">
      {/* Understanding + Confidence */}
      <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 shrink-0 mt-0.5">
              <Brain className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <p className="text-sm font-semibold">AI Understanding</p>
                <Badge variant="outline" className={`text-xs ${confidenceColor(insights.confidence)}`}>
                  {insights.confidence}% — {confidenceLabel(insights.confidence)}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {insights.understanding}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Match / No Match signals */}
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="border-border/30 bg-emerald-500/5 shadow-sm shadow-black/5">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Target className="h-4 w-4 text-emerald-400" />
              <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">What a match looks like</p>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">{insights.matchSignal}</p>
          </CardContent>
        </Card>
        <Card className="border-border/30 bg-muted/30 shadow-sm shadow-black/5">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <EyeOff className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">No match / out of stock</p>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">{insights.noMatchSignal}</p>
          </CardContent>
        </Card>
      </div>

      {/* Notices */}
      {insights.notices.length > 0 && (
        <Card className="border-amber-500/20 bg-amber-500/5 shadow-sm shadow-black/5">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
              <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Things to know</p>
            </div>
            <ul className="space-y-2">
              {insights.notices.map((notice, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Info className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{notice}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
