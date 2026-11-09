"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { errorText } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Eye, Loader2 } from "lucide-react";
import { formatMinorUnits, type GuessedAlertOn, type ProductListing, type SearchRegion } from "@prowl/shared";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AlertOnFields, alertOnFromFields, type PriceChoice } from "@/components/prowl/alert-on-fields";
import { ChannelSelector, defaultChannels, useConfiguredChannels, type Channel } from "@/components/prowl/channel-selector";
import { IntervalSelector } from "@/components/prowl/interval-selector";
import { useTier } from "@/hooks/use-tier";
import { trackListingReviewed, trackProductGroupCreated } from "@/lib/posthog";
import type { CheckInterval } from "@/convex/schema";

interface WatchProductFormProps {
  name: string;
  region: SearchRegion;
  /** The listings on screen. Accessories the user never revealed are not among them, so they are not saved. */
  listings: ProductListing[];
  /** URLs of the ticked listings. */
  ticked: Set<string>;
  /** Criteria guessed from a cloned monitor's prompt. */
  guess: GuessedAlertOn | null;
  onCreated: (groupId: Id<"monitorGroups">) => void;
  /** The listing picker, so the Watch bar stays on screen while the user picks. `missingShops` is set once Watch was pressed with nothing ticked. */
  children: (missingShops: boolean) => ReactNode;
}

/** The criteria step, then one monitor per ticked listing. Mount it per search, so the defaults follow the results. */
export function WatchProductForm({ name, region, listings, ticked, guess, onCreated, children }: WatchProductFormProps) {
  const create = useMutation(api.monitorGroups.create);
  // A cloned prompt says what they wanted. Without one, they get price drops,
  // plus restocks if a shop is out of stock.
  const guessed = guess && (guess.backInStock || guess.priceDrop || guess.priceBelow) ? guess : null;
  const outOfStock = listings.some((l) => l.inStock === false);
  const [backInStock, setBackInStock] = useState(guessed ? guessed.backInStock : outOfStock);
  const [priceChoice, setPriceChoice] = useState<PriceChoice>(
    guessed ? (guessed.priceBelow ? "below" : guessed.priceDrop ? "drop" : "off") : "drop"
  );
  const resultsCurrency = listings.find((l) => l.currency)?.currency ?? null;
  const oldTarget = guessed?.priceBelow ?? null;
  // The old amount is only kept in the results' own currency. Moving it to
  // another one would be a wrong price under the right label.
  const targetFits =
    !!oldTarget &&
    !!resultsCurrency &&
    (oldTarget.currency
      ? oldTarget.currency === resultsCurrency
      : !!oldTarget.symbol && !!formatMinorUnits(0, resultsCurrency)?.includes(oldTarget.symbol));
  const [target, setTarget] = useState(oldTarget && targetFits ? String(oldTarget.amount) : "");
  const [currency, setCurrency] = useState(resultsCurrency ?? "");
  const configuredChannels = useConfiguredChannels();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const { allowedIntervals, isLoading: tierLoading } = useTier();
  const [checkInterval, setCheckInterval] = useState<CheckInterval | null>(null);
  const [saving, setSaving] = useState(false);
  // Shown from the first press of Watch, then kept current, so it clears as soon as it is fixed.
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const shownChannels = channels ?? defaultChannels(configuredChannels) ?? ["email"];
  // allowedIntervals is fastest first.
  const shownInterval = checkInterval ?? (allowedIntervals[0] as CheckInterval);
  const watching = listings.filter((l) => ticked.has(l.url));

  const fields = alertOnFromFields({ backInStock, priceChoice, target, currency });
  const noShops = watching.length === 0;
  const problem = !backInStock && priceChoice === "off" ? "Pick what to be alerted about." : (fields.error ?? null);
  // The picker shows its own message for no shops, next to the checkboxes.
  const error = attempted && !noShops ? (problem ?? saveError) : null;
  const picker = useRef<HTMLDivElement>(null);

  async function submit() {
    setAttempted(true);
    setSaveError(null);
    if (noShops) {
      picker.current?.scrollIntoView({ block: "start" });
      picker.current?.querySelector<HTMLInputElement>("input[type=checkbox]:enabled")?.focus({ preventScroll: true });
      return;
    }
    if (problem !== null || fields.error !== undefined) return;
    setSaving(true);
    try {
      const { groupId } = await create({
        name,
        region,
        alertOn: fields.alertOn,
        notificationChannels: shownChannels,
        checkInterval: shownInterval,
        listings: listings.map((l) => ({
          site: l.site,
          url: l.url,
          title: l.title,
          price: l.price ?? undefined,
          currency: l.currency ?? undefined,
          inStock: l.inStock ?? undefined,
          label: l.label,
          watch: ticked.has(l.url),
        })),
      });
      trackProductGroupCreated({ listingCount: listings.length, watchingCount: watching.length });
      for (const l of listings) trackListingReviewed(ticked.has(l.url), { site: l.site, label: l.label });
      onCreated(groupId);
    } catch (err) {
      setSaveError(errorText(err, "We couldn't watch those listings. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div ref={picker} className="scroll-mt-4">{children(attempted && noShops)}</div>
      <section className="space-y-4" aria-labelledby="pick-alerts">
        <h3 id="pick-alerts" className="section-title">2. Choose your alerts</h3>
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
        {oldTarget && !targetFits && priceChoice === "below" && (
          <p className="pl-6 text-sm text-muted-foreground">
            Your old alert was under {oldTarget.written}.{" "}
            {resultsCurrency ? `Set a target in ${resultsCurrency}.` : "Set a target and pick its currency."}
          </p>
        )}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Check frequency</Label>
          <IntervalSelector value={shownInterval} onValueChange={setCheckInterval} />
        </div>
        <ChannelSelector value={shownChannels} onChange={setChannels} monitorId={null} />
      </section>
      <div className="sticky -bottom-4 -mx-4 -mb-4 space-y-2 border-t border-border bg-background px-4 py-3 sm:-bottom-6 sm:-mx-6 sm:-mb-6 sm:px-6">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center justify-between gap-3">
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {watching.length} shop{watching.length === 1 ? "" : "s"} selected
          </p>
          <Button
            type="button"
            className="gap-2"
            onClick={() => void submit()}
            disabled={saving || tierLoading || configuredChannels === undefined}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            {watching.length > 1 ? `Watch ${watching.length} shops` : watching.length === 1 ? "Watch 1 shop" : "Watch shops"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Each new monitor's first scan, live. Lands on `onDone` once every one has read its page. */
export function ProductProgress({ groupId, onDone }: { groupId: Id<"monitorGroups">; onDone: () => void }) {
  const group = useQuery(api.monitorGroups.get, { id: groupId });
  const watched = group?.listings.filter((l) => l.monitorId) ?? [];
  const allReady = watched.length > 0 && watched.every((l) => (l.monitor?.checkCount ?? 0) > 0);

  const landed = useRef(false);
  useEffect(() => {
    if (!allReady || landed.current) return;
    landed.current = true;
    onDone();
  }, [allReady, onDone]);

  if (group === undefined) {
    return <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />;
  }
  if (group === null) return null;

  return (
    <div className="space-y-4">
      <p className="text-sm">
        Watching <span className="font-medium">{group.name}</span>. We&apos;re reading each page now. You can
        leave, and it will carry on.
      </p>
      <ul aria-live="polite" className="space-y-2">
        {watched.map((listing) => {
          const m = listing.monitor;
          const ready = (m?.checkCount ?? 0) > 0;
          const failed = !ready && m?.status === "error";
          return (
            <li
              key={listing.url}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4 text-sm"
            >
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{listing.site}</p>
                <p className="truncate">{listing.title}</p>
              </div>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                {ready ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-primary" /> Ready
                  </>
                ) : failed ? (
                  <>
                    <AlertTriangle className="h-4 w-4 text-destructive" /> Couldn&apos;t read it
                  </>
                ) : (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {(m?.retryCount ?? 0) > 0 ? "Trying again" : "Scanning"}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={onDone}>
          Open product
        </Button>
      </div>
    </div>
  );
}
