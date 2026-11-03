"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { currencyExponent, toMinorUnits } from "@prowl/shared";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import type { CheckInterval } from "@/convex/schema";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AlertOnFields, type PriceChoice } from "@/components/prowl/alert-on-fields";
import { ChannelSelector, defaultChannels, useConfiguredChannels, type Channel } from "@/components/prowl/channel-selector";
import { IntervalSelector } from "@/components/prowl/interval-selector";
import { trackProductCriteriaUpdated } from "@/lib/posthog";

interface ProductCriteriaFormProps {
  group: Pick<Doc<"monitorGroups">, "_id" | "alertOn" | "notificationChannels" | "checkInterval">;
  /** For a new target price when the product has none yet. */
  listingCurrency: string;
  watchingCount: number;
}

/** A product's alert criteria, channels and interval. Saving copies them to every watched listing. */
export function ProductCriteriaForm({ group, listingCurrency, watchingCount }: ProductCriteriaFormProps) {
  const updateCriteria = useMutation(api.monitorGroups.updateCriteria);
  const savedTarget = group.alertOn.priceBelow;
  const [backInStock, setBackInStock] = useState(group.alertOn.backInStock === true);
  const [priceChoice, setPriceChoice] = useState<PriceChoice>(
    group.alertOn.priceDrop ? "drop" : savedTarget !== undefined ? "below" : "off"
  );
  const [target, setTarget] = useState(
    savedTarget !== undefined ? String(savedTarget.amount / 10 ** (currencyExponent(savedTarget.currency) ?? 2)) : ""
  );
  const [currency, setCurrency] = useState(savedTarget?.currency ?? listingCurrency);
  const configuredChannels = useConfiguredChannels();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const shownChannels = channels ?? group.notificationChannels ?? defaultChannels(configuredChannels) ?? ["email"];
  const [checkInterval, setCheckInterval] = useState<CheckInterval>(group.checkInterval);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!backInStock && priceChoice === "off") {
      toast.error("Pick what to be alerted about.");
      return;
    }
    const targetMinor = priceChoice === "below" ? toMinorUnits(Number(target), currency) : null;
    if (priceChoice === "below" && !targetMinor) {
      toast.error(currency ? "Enter a target price above zero." : "Pick the currency of your target price.");
      return;
    }
    setSaving(true);
    try {
      await updateCriteria({
        id: group._id,
        alertOn: {
          ...(backInStock ? { backInStock: true } : {}),
          ...(priceChoice === "drop" ? { priceDrop: true } : {}),
          ...(targetMinor ? { priceBelow: { amount: targetMinor, currency } } : {}),
        },
        notificationChannels: shownChannels,
        checkInterval,
      });
      trackProductCriteriaUpdated({ backInStock, price: priceChoice, checkInterval, watchingCount });
      toast.success("Product updated");
    } catch (err) {
      toast.error(err instanceof ConvexError ? String(err.data) : "We couldn't save the product. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border/40 bg-card/50 p-4">
      <div>
        <p className="text-sm font-medium">Alerts for every listing</p>
        <p className="text-xs text-muted-foreground">
          Saving copies these to every listing you watch. It replaces changes made on a listing&apos;s own page.
        </p>
      </div>
      <AlertOnFields
        backInStock={backInStock}
        onBackInStockChange={setBackInStock}
        priceChoice={priceChoice}
        onPriceChoiceChange={setPriceChoice}
        target={target}
        onTargetChange={setTarget}
        currency={currency}
        onCurrencyChange={setCurrency}
      />
      <div className="space-y-2">
        <Label className="text-sm font-medium">Check frequency</Label>
        <IntervalSelector value={checkInterval} onValueChange={setCheckInterval} />
      </div>
      <ChannelSelector
        value={shownChannels}
        onChange={setChannels}
        groupId={group._id}
        disabled={group.notificationChannels === undefined && configuredChannels === undefined}
      />
      <div className="flex justify-end">
        <Button type="button" size="sm" className="gap-1.5" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </Button>
      </div>
    </div>
  );
}
