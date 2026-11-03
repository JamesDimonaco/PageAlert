"use client";

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
} from "@prowl/shared";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatMinorUnits, toSafeUrl } from "@/lib/format";
import { trackProductSearchCompleted, trackProductSearchStarted } from "@/lib/posthog";

const LABELS: Record<ListingLabel, string> = {
  same: "Same product",
  similar: "Similar",
  accessory: "Accessory",
};

interface FindProductTabProps {
  /** Switch to the paste-a-URL form, carrying over what was typed. */
  onPasteUrl: (typed: string) => void;
}

export function FindProductTab({ onPasteUrl }: FindProductTabProps) {
  const status = useQuery(api.productSearch.status);
  const search = useAction(api.productSearch.search);

  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<SearchRegion | null>(null);
  const [guessed, setGuessed] = useState<SearchRegion | null>(null);
  const [changingRegion, setChangingRegion] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ProductListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAccessories, setShowAccessories] = useState(false);

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
    trackProductSearchStarted({ region });
    const started = Date.now();
    try {
      const listings = await search({ query: query.trim(), region });
      setResults(listings);
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
                if (v && isSearchRegion(v)) setPicked(v);
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
          <ul className="space-y-2">
            {shown.map((listing) => (
              <ListingRow key={listing.url} listing={listing} />
            ))}
          </ul>
          {accessories.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAccessories((s) => !s)}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              {showAccessories ? "Hide accessories" : `Show accessories (${accessories.length})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ListingRow({ listing }: { listing: ProductListing }) {
  const price = listing.price !== null && listing.currency ? formatMinorUnits(listing.price, listing.currency) : null;
  const href = toSafeUrl(listing.url);
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-border/40 bg-card/50 p-3">
      <div className="min-w-0 space-y-1">
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
