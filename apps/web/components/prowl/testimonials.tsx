"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import { MessageSquare } from "lucide-react";

export function Testimonials() {
  const reviews = useQuery(api.reviews.listPublic);

  if (!reviews || reviews.length === 0) return null;

  return (
    <section className="border-t border-border/30">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-28">
        <div className="mx-auto max-w-2xl text-center mb-16">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight leading-tight">
            What our users say
          </h2>
        </div>
        <div className="grid gap-6 md:grid-cols-3 max-w-4xl mx-auto">
          {reviews.map((r) => (
            <Card key={r.id} className="border-border/30 bg-card/50">
              <CardContent className="p-6">
                <MessageSquare className="h-5 w-5 text-primary/40 mb-3" />
                <p className="text-sm leading-relaxed text-foreground/80 mb-4">
                  &ldquo;{r.quote}&rdquo;
                </p>
                <div>
                  <p className="text-sm font-semibold">{r.displayName}</p>
                  {r.role && (
                    <p className="text-xs text-muted-foreground">{r.role}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
