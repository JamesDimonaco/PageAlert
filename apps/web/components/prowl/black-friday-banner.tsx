"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { BLACK_FRIDAY_CODE, isBlackFridayLive } from "@/lib/black-friday";

/**
 * A thin strip advertising the Black Friday code. The pages are pre-rendered,
 * so the cut-off is checked in the browser: a build-time check would keep the
 * strip up after the code stops working.
 */
const noSubscribe = () => () => {};

export function BlackFridayBanner({ href }: { href?: string }) {
  // Hidden on the server, checked against the clock in the browser.
  const live = useSyncExternalStore(noSubscribe, () => isBlackFridayLive(Date.now()), () => false);
  const [copied, setCopied] = useState(false);

  if (!live) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(BLACK_FRIDAY_CODE);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the code is on screen to type by hand.
    }
  }

  return (
    <div className="bg-primary px-4 py-2 text-center text-sm text-primary-foreground">
      <span className="font-semibold">Black Friday:</span> half price on every plan for the first month.{" "}
      <button
        type="button"
        onClick={copy}
        className="mx-1 inline-flex items-center gap-1 rounded border border-primary-foreground/40 px-1.5 py-0.5 font-mono text-xs font-semibold hover:bg-primary-foreground/10"
        aria-label={copied ? "Code copied" : `Copy code ${BLACK_FRIDAY_CODE}`}
      >
        {BLACK_FRIDAY_CODE}
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
      {href ? (
        <Link href={href} className="font-medium underline underline-offset-2">
          Set your deal alerts now
        </Link>
      ) : (
        <span>Ends 30 November.</span>
      )}
    </div>
  );
}
