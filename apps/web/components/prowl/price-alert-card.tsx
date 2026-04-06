"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { TrendingDown, TrendingUp, X, Plus, Loader2, BarChart3 } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import type { ExtractedItem } from "@prowl/shared";
import { getItemKey } from "@prowl/shared";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { formatPrice } from "@/lib/format";
import { trackEvent, captureException } from "@/lib/posthog";
import { toast } from "sonner";

interface PriceAlertCardProps {
  monitorId: Id<"monitors">;
  priceAlerts?: {
    onPriceDrop: boolean;
    onPriceIncrease: boolean;
    belowThreshold?: number;
    aboveThreshold?: number;
    trackedItems: string[];
    minChangePercent?: number;
    cooldownMs?: number;
  };
  allItems: ExtractedItem[];
  suggestedPriceTrackItems: string[];
  currency?: string;
  muted?: boolean;
}

const pricedOf = (items: ExtractedItem[]) => items.filter((i) => i.price != null && Number.isFinite(Number(i.price)));
const titleOf = (item: ExtractedItem) => String(item.title ?? item.name ?? "Unknown");
const findByKey = (items: ExtractedItem[], key: string) => items.find((i) => getItemKey(i) === key);

export function PriceAlertCard({ monitorId, priceAlerts, allItems, suggestedPriceTrackItems, currency = "USD", muted }: PriceAlertCardProps) {
  const update = useMutation(api.monitors.update);
  const pricedItems = pricedOf(allItems);
  const isConfigured = priceAlerts && priceAlerts.trackedItems.length > 0;
  const suggestedKeys = suggestedPriceTrackItems
    .map((t) => { const f = pricedItems.find((i) => titleOf(i).toLowerCase() === t.toLowerCase()); return f ? getItemKey(f) : null; })
    .filter(Boolean) as string[];

  const [selectedKeys, setSelectedKeys] = useState<string[]>(suggestedKeys);
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [onPriceDrop, setOnPriceDrop] = useState(priceAlerts?.onPriceDrop ?? true);
  const [onPriceIncrease, setOnPriceIncrease] = useState(priceAlerts?.onPriceIncrease ?? false);
  const [belowThreshold, setBelowThreshold] = useState(priceAlerts?.belowThreshold?.toString() ?? "");
  const [aboveThreshold, setAboveThreshold] = useState(priceAlerts?.aboveThreshold?.toString() ?? "");
  const [showAddList, setShowAddList] = useState(false);

  // Sync selectedKeys when AI suggestions arrive async (Convex reactivity)
  useEffect(() => {
    if (!isConfigured && suggestedKeys.length > 0) {
      setSelectedKeys(suggestedKeys);
    }
  }, [suggestedKeys.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync edit state when props change from server (e.g. saved from another tab)
  useEffect(() => {
    if (!editing && priceAlerts) {
      setOnPriceDrop(priceAlerts.onPriceDrop);
      setOnPriceIncrease(priceAlerts.onPriceIncrease);
      setBelowThreshold(priceAlerts.belowThreshold?.toString() ?? "");
      setAboveThreshold(priceAlerts.aboveThreshold?.toString() ?? "");
    }
  }, [priceAlerts?.onPriceDrop, priceAlerts?.onPriceIncrease, priceAlerts?.belowThreshold, priceAlerts?.aboveThreshold]); // eslint-disable-line react-hooks/exhaustive-deps

  const sym = currency === "GBP" ? "\u00a3" : currency === "EUR" ? "\u20ac" : "$";

  async function save(fn: () => Promise<unknown>, successMsg: string, event?: string) {
    setSaving(true);
    try {
      await fn();
      if (event) trackEvent(event, { monitorId });
      toast.success(successMsg);
    } catch (e) {
      captureException(e, { monitorId });
      toast.error("Failed", { description: e instanceof Error ? e.message : "" });
    } finally { setSaving(false); }
  }

  function parseThreshold(val: string): number | undefined {
    if (!val) return undefined;
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  async function handleStartTracking() {
    if (!selectedKeys.length) return;
    await save(
      () => update({ id: monitorId, priceAlerts: { onPriceDrop: true, onPriceIncrease: false, trackedItems: selectedKeys } } as any),
      "Price tracking enabled", "price_tracking_configured",
    );
  }

  async function handleSave() {
    await save(async () => {
      await update({ id: monitorId, priceAlerts: {
        ...priceAlerts!,
        onPriceDrop, onPriceIncrease,
        belowThreshold: parseThreshold(belowThreshold),
        aboveThreshold: parseThreshold(aboveThreshold),
      }} as any);
      setEditing(false);
    }, "Price alerts updated", "price_alerts_updated");
  }

  async function handleRemoveItem(key: string) {
    const next = priceAlerts!.trackedItems.filter((k) => k !== key);
    await save(() => update({ id: monitorId, priceAlerts: { ...priceAlerts!, trackedItems: next } } as any), "Item removed");
  }

  async function handleAddItem(key: string) {
    const next = [...priceAlerts!.trackedItems, key];
    await save(() => update({ id: monitorId, priceAlerts: { ...priceAlerts!, trackedItems: next } } as any), "Item added");
  }

  const cardCls = "border-border/30 bg-card/50 shadow-sm shadow-black/5";
  const header = (
    <div className="flex items-center gap-2">
      <BarChart3 className="h-5 w-5 text-primary" />
      <h3 className="text-sm font-semibold">Price Tracking</h3>
    </div>
  );

  // --- First-time setup ---
  if (!isConfigured) {
    if (dismissed) return null;
    return (
      <Card className={cardCls}>
        <CardContent className="p-6">
          <div className="mb-4">{header}</div>
          <p className="text-sm text-muted-foreground mb-3">AI suggests tracking these items:</p>
          <div className="space-y-2 mb-4">
            {pricedItems.map((item) => {
              const key = getItemKey(item);
              return (
                <label key={key} className="flex items-center justify-between gap-3 cursor-pointer">
                  <div className="flex items-center gap-2 min-w-0">
                    <input type="checkbox" checked={selectedKeys.includes(key)} onChange={() => setSelectedKeys((p) => p.includes(key) ? p.filter((k) => k !== key) : [...p, key])} className="rounded border-border accent-primary h-4 w-4 shrink-0" />
                    <span className="text-sm truncate">{titleOf(item)}</span>
                  </div>
                  <span className="text-sm font-medium text-muted-foreground shrink-0">{formatPrice(item.price, currency)}</span>
                </label>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleStartTracking} disabled={saving || !selectedKeys.length}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}Start tracking
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>Not now</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // --- Configured state ---
  const trackedKeys = priceAlerts!.trackedItems;
  const untrackedPriced = pricedItems.filter((i) => !trackedKeys.includes(getItemKey(i)));

  // In view mode, display values from props; in edit mode, display local state
  const displayPriceDrop = editing ? onPriceDrop : priceAlerts!.onPriceDrop;
  const displayPriceIncrease = editing ? onPriceIncrease : priceAlerts!.onPriceIncrease;

  return (
    <Card className={cardCls}>
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {header}
            <Badge variant="outline" className="text-xs">{trackedKeys.length} items</Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={() => {
            if (!editing) {
              setOnPriceDrop(priceAlerts!.onPriceDrop);
              setOnPriceIncrease(priceAlerts!.onPriceIncrease);
              setBelowThreshold(priceAlerts!.belowThreshold?.toString() ?? "");
              setAboveThreshold(priceAlerts!.aboveThreshold?.toString() ?? "");
            }
            setEditing(!editing);
          }}>{editing ? "Done" : "Edit"}</Button>
        </div>

        <div className="space-y-1.5 mb-4">
          {trackedKeys.map((key) => {
            const item = findByKey(allItems, key);
            return (
              <div key={key} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{item ? titleOf(item) : key}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-medium text-muted-foreground">{item ? formatPrice(item.price, currency) : "\u2014"}</span>
                  {editing && <button type="button" onClick={() => handleRemoveItem(key)} className="text-muted-foreground hover:text-red-400 transition-colors" disabled={saving}><X className="h-3.5 w-3.5" /></button>}
                </div>
              </div>
            );
          })}
          {editing && untrackedPriced.length > 0 && (
            <>
              <button type="button" onClick={() => setShowAddList(!showAddList)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mt-1">
                <Plus className="h-3.5 w-3.5" /> Add item
              </button>
              {showAddList && (
                <div className="pl-5 space-y-1 mt-1">
                  {untrackedPriced.map((item) => (
                    <div key={getItemKey(item)} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-muted-foreground">{titleOf(item)}</span>
                      <button type="button" onClick={() => handleAddItem(getItemKey(item))} className="text-primary hover:text-primary/80 transition-colors" disabled={saving}><Plus className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <hr className="border-border/30 mb-4" />
        <div className="space-y-2 mb-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={displayPriceDrop} onChange={(e) => editing && setOnPriceDrop(e.target.checked)} disabled={!editing} className="rounded border-border accent-primary h-4 w-4" />
            <TrendingDown className="h-3.5 w-3.5 text-emerald-400" /><span className="text-sm">Notify on price drops</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={displayPriceIncrease} onChange={(e) => editing && setOnPriceIncrease(e.target.checked)} disabled={!editing} className="rounded border-border accent-primary h-4 w-4" />
            <TrendingUp className="h-3.5 w-3.5 text-amber-400" /><span className="text-sm">Notify on price increases</span>
          </label>
        </div>

        {editing && (
          <div className="flex flex-wrap items-center gap-4 mb-4">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Alert below:</span>
              <div className="relative w-28">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{sym}</span>
                <Input type="number" placeholder="No limit" value={belowThreshold} onChange={(e) => setBelowThreshold(e.target.value)} className="pl-6 h-8 text-sm" />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Alert above:</span>
              <div className="relative w-28">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{sym}</span>
                <Input type="number" placeholder="No limit" value={aboveThreshold} onChange={(e) => setAboveThreshold(e.target.value)} className="pl-6 h-8 text-sm" />
              </div>
            </div>
          </div>
        )}
        {editing && (
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}Save changes
          </Button>
        )}
        {muted && <p className="text-xs text-amber-400 mt-3">Notifications are muted for this monitor</p>}
      </CardContent>
    </Card>
  );
}
