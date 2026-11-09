"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { errorText } from "@/lib/utils";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import type { CheckInterval } from "@/convex/schema";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AlertOnFields, alertOnFromFields, targetText, type PriceChoice } from "@/components/prowl/alert-on-fields";
import { ChannelSelector, defaultChannels, useConfiguredChannels, type Channel } from "@/components/prowl/channel-selector";
import { IntervalSelector } from "@/components/prowl/interval-selector";
import { trackProductCriteriaUpdated } from "@/lib/posthog";

interface ProductCriteriaFormProps {
  group: Pick<Doc<"monitorGroups">, "_id" | "alertOn" | "notificationChannels" | "checkInterval">;
  /** For a new target price when the product has none yet. */
  listingCurrency: string;
  watchingCount: number;
}

/** Why the plan changed what the user asked for, in plain words. */
export function planNotes(asked: Channel[], got: Channel[], askedInterval: CheckInterval, gotInterval: CheckInterval): string[] {
  const dropped = asked.filter((c) => !got.includes(c));
  const notes: string[] = [];
  const rationed = dropped.filter((c) => c === "telegram" || c === "discord");
  if (rationed.length > 0) {
    const names = rationed.map((c) => (c === "telegram" ? "Telegram" : "Discord")).join(" and ");
    notes.push(
      `${names} ${rationed.length === 1 ? "is" : "are"} off. The free plan allows Telegram and Discord on one monitor or product, and another one already uses them.`
    );
  }
  if (dropped.includes("sms")) notes.push("Text alerts are off. They aren't on the free plan.");
  // The free plan sends email when it removes every channel asked for.
  if (got.includes("email") && !asked.includes("email")) notes.push("Alerts go by email instead.");
  if (gotInterval !== askedInterval) notes.push(`Checks run every ${gotInterval}, the fastest your plan allows.`);
  return notes;
}

/** A product's alert criteria, channels and interval. Saving copies them to every watched listing. */
export function ProductCriteriaForm({ group, listingCurrency, watchingCount }: ProductCriteriaFormProps) {
  const updateCriteria = useMutation(api.monitorGroups.updateCriteria);
  const savedTarget = group.alertOn.priceBelow;
  const [backInStock, setBackInStock] = useState(group.alertOn.backInStock === true);
  const [priceChoice, setPriceChoice] = useState<PriceChoice>(
    group.alertOn.priceDrop ? "drop" : savedTarget !== undefined ? "below" : "off"
  );
  const [target, setTarget] = useState(targetText(savedTarget));
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
    const fields = alertOnFromFields({ backInStock, priceChoice, target, currency });
    if (fields.error !== undefined) {
      toast.error(fields.error);
      return;
    }
    setSaving(true);
    try {
      const saved = await updateCriteria({
        id: group._id,
        alertOn: fields.alertOn,
        notificationChannels: shownChannels,
        checkInterval,
      });
      trackProductCriteriaUpdated({ backInStock, price: priceChoice, checkInterval: saved.checkInterval, watchingCount });
      // Show what the plan let the product have, so the next save sends that.
      setChannels(saved.notificationChannels);
      setCheckInterval(saved.checkInterval);
      const notes = planNotes(shownChannels, saved.notificationChannels, checkInterval, saved.checkInterval);
      if (notes.length > 0) toast.warning("Product updated", { description: notes.join(" "), duration: 10000 });
      else toast.success("Product updated");
    } catch (err) {
      toast.error(errorText(err, "We couldn't save the product. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div>
        <h2 className="section-title">Alerts for every listing</h2>
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
