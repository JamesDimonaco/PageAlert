"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { trackEvent } from "@/lib/posthog";

/**
 * Client-side wrapper for the "Explore the full live example" CTA on the
 * homepage example card. Lives in its own file so the parent
 * <ExampleResults /> stays server-rendered. See PROWL-038 Phase 5.
 */
export function ExampleResultsCta() {
  return (
    <div className="border-t border-border/20 px-4 sm:px-6 py-4 bg-muted/10">
      <Link
        href="/try/example"
        onClick={() => trackEvent("homepage_cta_clicked", { cta: "example_link_card" })}
        className={buttonVariants({
          size: "lg",
          variant: "outline",
          className: "w-full gap-2 group",
        })}
      >
        Explore the full live example
        <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
      </Link>
      <p className="text-xs text-muted-foreground text-center mt-2">
        Real scan, real data &mdash; no signup needed
      </p>
    </div>
  );
}
