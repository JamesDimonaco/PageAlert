"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { Loader2, Store } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { trackEvent } from "@/lib/posthog";
import { errorText } from "@/lib/utils";

/**
 * Turns the monitor into a product, then opens it with ?find=1 so the product
 * page runs the store search. The search can take two minutes, and the
 * monitor's own card is gone from the dashboard the moment it converts.
 */
export function useFindStores(monitorId: Id<"monitors">, source: "card" | "detail") {
  const convert = useMutation(api.monitorGroups.convertMonitor);
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const groupId = await convert({ monitorId });
      trackEvent("monitor_converted_to_product", { source });
      router.push(`/dashboard/products/${groupId}?find=1`);
    } catch (err) {
      toast.error(errorText(err, "Couldn't search for other stores. Try again."));
      setBusy(false);
    }
  }

  return { run, busy };
}

export function FindStoresButton({
  monitorId,
  source,
  variant = "outline",
}: {
  monitorId: Id<"monitors">;
  source: "card" | "detail";
  variant?: "outline" | "default";
}) {
  const { run, busy } = useFindStores(monitorId, source);
  return (
    <Button variant={variant} size="sm" className="relative z-10 gap-1.5 max-sm:h-11" onClick={() => void run()} disabled={busy}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Store className="h-4 w-4" />}
      Find other stores
    </Button>
  );
}

/** Shown on a single-shop product page that has sold out: the moment other shops matter most. */
export function OutOfStockCallout({ monitorId, url, source }: { monitorId: Id<"monitors">; url: string; source: "card" | "detail" }) {
  let site = "this shop";
  try {
    site = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Keep the fallback.
  }
  return (
    <div className="relative z-10 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5">
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium">Out of stock at {site}.</span>{" "}
        <span className="text-muted-foreground">Search other shops and watch them here too.</span>
      </p>
      <FindStoresButton monitorId={monitorId} source={source} variant="default" />
    </div>
  );
}
