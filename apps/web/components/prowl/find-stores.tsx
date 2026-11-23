"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Loader2, Store } from "lucide-react";
import { toast } from "sonner";
import { formatMinorUnits } from "@prowl/shared";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { AlertOn } from "@/convex/schema";
import { displayHost } from "@/convex/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trackEvent } from "@/lib/posthog";
import { errorText } from "@/lib/utils";

type Source = "card" | "detail";

/**
 * "Find other stores" for one monitor: `open` shows the confirm dialog, and
 * `dialog` must be rendered once. Every button for the monitor shares it, so
 * they share one busy state too.
 */
export function useFindStores(monitorId: Id<"monitors">, url: string, source: Source) {
  const [open, setOpen] = useState(false);
  return {
    open: () => setOpen(true),
    dialog: <FindStoresDialog monitorId={monitorId} url={url} source={source} open={open} onOpenChange={setOpen} />,
  };
}

function describeAlerts(alertOn: AlertOn): string {
  const parts: string[] = [];
  if (alertOn.backInStock) parts.push("it's back in stock");
  if (alertOn.priceDrop) parts.push("the price drops");
  if (alertOn.priceBelow) {
    const { amount, currency } = alertOn.priceBelow;
    parts.push(`the price is ${formatMinorUnits(amount, currency) ?? `${amount} ${currency}`} or less`);
  }
  return parts.join(", or ");
}

function FindStoresDialog({
  monitorId,
  url,
  source,
  open,
  onOpenChange,
}: {
  monitorId: Id<"monitors">;
  url: string;
  source: Source;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = useQuery(api.monitorGroups.conversionPreview, open ? { monitorId } : "skip");
  const convert = useMutation(api.monitorGroups.convertMonitor);
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  // Opens the product with ?find=1 so its page runs the store search. That can
  // take two minutes, and this monitor's card leaves the dashboard at once.
  async function confirm() {
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

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Find other stores</DialogTitle>
          <DialogDescription>
            This monitor becomes a product, with {displayHost(url)} as its first shop. Then we search for other shops
            selling it, and you pick which to watch.
          </DialogDescription>
        </DialogHeader>
        {preview === undefined ? (
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
        ) : "refusal" in preview ? (
          <p className="text-sm text-destructive">{preview.refusal}</p>
        ) : (
          <div className="space-y-3 text-sm">
            <p>
              You&apos;ll be alerted when {describeAlerts(preview.alertOn)}. You can change this on the product
              afterwards.
            </p>
            <p className="text-muted-foreground">
              It stops using your prompt, &ldquo;{preview.oldPrompt}&rdquo;, so anything else it asks for, like a size
              or colour, no longer alerts. Price and match history stay.
            </p>
            <p className="text-muted-foreground">This uses one of today&apos;s store searches.</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void confirm()} disabled={busy || !preview || "refusal" in preview} className="gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Store className="h-4 w-4" />}
            Find other stores
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FindStoresButton({ onClick, variant = "outline" }: { onClick: () => void; variant?: "outline" | "default" }) {
  return (
    <Button variant={variant} size="sm" className="relative z-10 gap-1.5 max-sm:h-11" onClick={onClick}>
      <Store className="h-4 w-4" />
      Find other stores
    </Button>
  );
}

/**
 * Shown on a single-shop product page that has sold out: the moment other
 * shops matter most. Only while the monitor still reads stock, since an old
 * reading is never updated once stock and price alerts are off.
 */
export function showOutOfStock(monitor: { alertOn?: AlertOn; lastSeen?: { inStock?: boolean } }): boolean {
  const reading = monitor.alertOn?.backInStock === true || monitor.alertOn?.priceDrop === true || monitor.alertOn?.priceBelow !== undefined;
  return reading && monitor.lastSeen?.inStock === false;
}

export function OutOfStockCallout({ url, onFind }: { url: string; onFind: () => void }) {
  return (
    <div className="relative z-10 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5">
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium">Out of stock at {displayHost(url)}.</span>{" "}
        <span className="text-muted-foreground">Search other shops and watch them here too.</span>
      </p>
      <FindStoresButton onClick={onFind} variant="default" />
    </div>
  );
}
