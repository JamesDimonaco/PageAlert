"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { ExternalLink, Loader2, Search } from "lucide-react";
import {
  SEARCH_REGIONS,
  guessSearchRegion,
  isSearchRegion,
  type ListingLabel,
  type ProductListing,
  type SearchRegion,
  type GuessedAlertOn,
} from "@prowl/shared";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toSafeUrl } from "@/lib/format";
import { formatMinorUnits } from "@prowl/shared";
import { trackCloneAsProductOpened, trackProductSearchCompleted, trackProductSearchStarted } from "@/lib/posthog";
import { useTier } from "@/hooks/use-tier";
import { ProductProgress, WatchProductForm } from "./watch-product";

const LABELS: Record<ListingLabel, string> = {
  same: "Same product",
  similar: "Similar",
  accessory: "Accessory",
};

interface FindProductTabProps {
  /** From Clone: the search to start with, and criteria guessed from the old prompt. Read on mount. */
  clone: { query: string; guess: GuessedAlertOn } | null;
  /** Switch to the paste-a-URL form, carrying over what was typed. */
  onPasteUrl: (typed: string) => void;
  /** Called once the new product's monitors are under way. */
  onDone: () => void;
}

export function FindProductTab({ clone, onPasteUrl, onDone }: FindProductTabProps) {
  const status = useQuery(api.productSearch.status);
  const search = useAction(api.productSearch.search);

  // Not searched for them: searches are limited, so the user presses Search.
  const [query, setQuery] = useState(clone?.query ?? "");
  useEffect(() => {
    if (!clone) return;
    const { guess } = clone;
    trackCloneAsProductOpened({
      backInStock: guess.backInStock,
      priceDrop: guess.priceDrop,
      priceBelow: guess.priceBelow !== null,
    });
  }, [clone]);
  const [picked, setPicked] = useState<SearchRegion | null>(null);
  const [guessed, setGuessed] = useState<SearchRegion | null>(null);
  const [changingRegion, setChangingRegion] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ProductListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAccessories, setShowAccessories] = useState(false);
  // `at` is the clock the creation limit is counted against, read when the results arrive.
  const [searched, setSearched] = useState<{ query: string; region: SearchRegion; at: number } | null>(null);
  const [searchCount, setSearchCount] = useState(0);
  // Always a subset of the listings on screen, so it is what gets watched.
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [createdId, setCreatedId] = useState<Id<"monitorGroups"> | null>(null);
  const monitors = useQuery(api.monitors.list);
  const allowance = useQuery(api.monitors.creationAllowance);
  const { maxMonitors, isLoading: tierLoading } = useTier();
  const slotsLoading = monitors === undefined || allowance === undefined || tierLoading;
  // Every monitor counts toward the plan, paused ones included.
  const freeSlots = slotsLoading ? 0 : Math.max(0, maxMonitors - monitors.length);
  const creationsLeft =
    allowance && searched
      ? Math.max(0, allowance.limit - allowance.recent.filter((t) => searched.at - t < allowance.windowMs).length)
      : 0;

  const saved = status?.region && isSearchRegion(status.region) ? status.region : null;
  const region = picked ?? saved ?? guessed;
  const needsGuess = status !== undefined && !saved && !guessed;

  // Only a first-time searcher needs the guess; after that their last region is saved.
  useEffect(() => {
    if (!needsGuess) return;
    let cancelled = false;
    fetch("/api/region")
      .then((res) => (res.ok ? (res.json() as Promise<{ country: string | null }>) : { country: null }))
      .catch(() => ({ country: null }))
      .then(({ country }) => {
        if (!cancelled) setGuessed(guessSearchRegion(country, navigator.language));
      });
    return () => {
      cancelled = true;
    };
  }, [needsGuess]);

  const regionInfo = SEARCH_REGIONS.find((r) => r.code === region);
  // The count resets at UTC midnight, the day the server counts on.
  const remaining = status
    ? status.day === new Date().toISOString().slice(0, 10)
      ? Math.max(0, status.limit - status.used)
      : status.limit
    : undefined;
  const outOfSearches = remaining === 0;

  async function runSearch() {
    if (!region || query.trim().length < 2) return;
    setSearching(true);
    setError(null);
    setResults(null);
    setShowAccessories(false);
    setTicked(new Set());
    setSearchCount((c) => c + 1);
    trackProductSearchStarted({ region });
    const started = Date.now();
    const typed = query.trim();
    try {
      const listings = await search({ query: typed, region });
      setResults(listings);
      setSearched({ query: typed, region, at: Date.now() });
      trackProductSearchCompleted({ region, resultCount: listings.length, durationMs: Date.now() - started, failed: false });
    } catch (err) {
      setError(err instanceof ConvexError ? String(err.data) : "The search didn't work. Try again.");
      trackProductSearchCompleted({ region, resultCount: 0, durationMs: Date.now() - started, failed: true });
    } finally {
      setSearching(false);
    }
  }

  const accessories = results?.filter((l) => l.label === "accessory") ?? [];
  const shown = results?.filter((l) => showAccessories || l.label !== "accessory") ?? [];

  function toggleAccessories() {
    if (showAccessories) {
      setTicked((prev) => new Set([...prev].filter((url) => !accessories.some((a) => a.url === url))));
    }
    setShowAccessories(!showAccessories);
  }

  function toggle(url: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  if (createdId) return <ProductProgress groupId={createdId} onDone={onDone} />;

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
        className="space-y-2"
      >
        <Label htmlFor="find-query" className="text-sm font-medium">Product name</Label>
        <div className="flex gap-2">
          <Input
            id="find-query"
            placeholder="e.g. Sony WH-1000XM5"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={200}
            required
          />
          <Button
            type="submit"
            className="gap-2 shrink-0"
            disabled={searching || !region || outOfSearches || query.trim().length < 2}
          >
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          {changingRegion ? (
            <Select
              value={region ?? undefined}
              onValueChange={(v) => {
                if (v && isSearchRegion(v) && v !== region) {
                  setPicked(v);
                  // Results from another country's shops would be saved under this one.
                  setResults(null);
                  setError(null);
                  setTicked(new Set());
                }
                setChangingRegion(false);
              }}
            >
              <SelectTrigger className="h-7 w-[180px] text-xs" aria-label="Country to search">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEARCH_REGIONS.map((r) => (
                  <SelectItem key={r.code} value={r.code}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span>
              {regionInfo ? `Searching ${regionInfo.sites} sites` : "Finding your country…"}
              {regionInfo && (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => setChangingRegion(true)}
                    className="underline hover:text-foreground"
                  >
                    change
                  </button>
                </>
              )}
            </span>
          )}
          {status && (
            <span>
              {remaining} of {status.limit} searches left today
            </span>
          )}
        </div>
      </form>

      {searching && (
        <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          Searching shops. This can take up to a minute.
        </div>
      )}

      {(error || results?.length === 0) && (
        <div className="space-y-3 rounded-lg border border-border/40 bg-card/50 p-4 text-sm">
          <p>{error ?? "We couldn't find that product in any shop. It hasn't counted toward today's limit."}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => onPasteUrl(query.trim())}>
            Paste a URL instead
          </Button>
        </div>
      )}

      {results && results.length > 0 && (
        <div className="space-y-2">
          {slotsLoading ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Checking your free monitors…
            </p>
          ) : creationsLeft < freeSlots && allowance ? (
            <p className="text-xs text-muted-foreground">
              Your plan lets you add {allowance.limit} monitors every 5 hours.{" "}
              {creationsLeft === 0
                ? "You've added that many, so try again later."
                : `You can tick ${creationsLeft} now.`}
            </p>
          ) : freeSlots === 0 ? (
            <p className="text-xs text-muted-foreground">
              You&apos;re using all {maxMonitors} of your monitors. Paused ones still count, so delete one to free a
              slot, or{" "}
              <Link href="/dashboard/settings?tab=billing" className="underline hover:text-foreground">upgrade</Link>.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Tick the listings to watch. You have {freeSlots} free monitor{freeSlots === 1 ? "" : "s"}.
            </p>
          )}
          <ul className="space-y-2">
            {shown.map((listing) => (
              <ListingRow
                key={listing.url}
                listing={listing}
                checked={ticked.has(listing.url)}
                disabled={!ticked.has(listing.url) && ticked.size >= Math.min(freeSlots, creationsLeft)}
                onToggle={() => toggle(listing.url)}
              />
            ))}
          </ul>
          {accessories.length > 0 && (
            <button
              type="button"
              onClick={toggleAccessories}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              {showAccessories ? "Hide accessories" : `Show accessories (${accessories.length})`}
            </button>
          )}
          {searched && (
            <WatchProductForm
              key={searchCount}
              name={searched.query}
              region={searched.region}
              listings={shown}
              ticked={ticked}
              guess={clone?.guess ?? null}
              onCreated={setCreatedId}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ListingRow({
  listing,
  checked,
  disabled,
  onToggle,
}: {
  listing: ProductListing;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const price = listing.price !== null && listing.currency ? formatMinorUnits(listing.price, listing.currency) : null;
  const href = toSafeUrl(listing.url);
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-border/40 bg-card/50 p-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        aria-label={`Watch ${listing.site}`}
        className="mt-1 h-4 w-4 shrink-0 rounded border-border accent-primary"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs text-muted-foreground">{listing.site}</p>
        <p className="text-sm font-medium leading-snug">{listing.title}</p>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {price && <span className="font-semibold">{price}</span>}
          {listing.inStock !== null && (
            <Badge variant={listing.inStock ? "secondary" : "destructive"}>
              {listing.inStock ? "In stock" : "Out of stock"}
            </Badge>
          )}
          <Badge variant="outline">{LABELS[listing.label]}</Badge>
        </div>
      </div>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Open ${listing.site}`}
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      )}
    </li>
  );
}
