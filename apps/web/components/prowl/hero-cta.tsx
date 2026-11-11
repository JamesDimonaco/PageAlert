"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { trackEvent } from "@/lib/posthog";

export function HeroCTA() {
  const session = authClient.useSession();
  const isLoggedIn = !session.isPending && !!session.data?.user;
  const ctaHref = isLoggedIn ? "/dashboard" : "/login";

  // One primary CTA + one quiet text-link secondary. The previous
  // dual-button hero made "See how it works" feel like the safer choice
  // for hesitant visitors, who would scroll briefly and bounce. The
  // text-link below points to the strongest signed-out demo we have
  // (/try/example) instead of an in-page anchor. See PROWL-038 Phase 5.
  return (
    <div className="mt-12 flex flex-col items-center gap-3">
      <Link
        href={ctaHref}
        onClick={() => trackEvent("homepage_cta_clicked", { cta: "primary_signup" })}
        className={buttonVariants({
          size: "lg",
          className: "gap-2 h-14 px-10 text-base font-semibold shadow-xl shadow-primary/25 w-full sm:w-auto",
        })}
      >
        {isLoggedIn ? "Go to dashboard" : "Start monitoring"}
        <ArrowRight className="h-5 w-5" />
      </Link>
      <Link
        href="/try/example"
        onClick={() => trackEvent("homepage_cta_clicked", { cta: "example_link_hero" })}
        className="text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4 decoration-muted-foreground/30 hover:decoration-foreground"
      >
        Or see a real example first &rarr;
      </Link>
    </div>
  );
}
