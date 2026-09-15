"use client";

import { useCallback, useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MatchConditionsEditor } from "@/components/prowl/match-conditions-editor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ExternalLink,
  Search,
  CheckCircle2,
  Ban,
  RotateCcw,
  X,
  Save,
  Loader2,
  RefreshCw,
  Filter,
  ArrowUpDown,
  TrendingDown,
  TrendingUp,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import type { ExtractedItem, MatchConditions, ExtractionSchema } from "@prowl/shared";
import { applyMatchConditions, canonicalUrl, getItemKey, itemIdentity, MATCH_CONFIDENCE_LABEL, matchConfidence } from "@prowl/shared";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import { trackFilterSaved, trackItemDismissed, trackItemRestored } from "@/lib/posthog";
import { formatPrice, toSafeUrl } from "@/lib/format";

interface ItemsTabProps {
  monitorId: Id<"monitors">;
  allItems: ExtractedItem[];
  schema: ExtractionSchema | undefined;
  blacklist: string[];
  scores: Record<string, { matchScore: number; matchReason: string }>;
  showFilters: boolean;
  onShowFiltersChange: (v: boolean) => void;
}

/** Bands, not raw percentages — the judged score is the model's own estimate and is not calibrated. */
function confidenceStyle(score: number): string {
  const band = matchConfidence(score);
  if (band === "strong") return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
  if (band === "likely") return "bg-amber-500/10 text-amber-400 border-amber-500/20";
  return "bg-muted text-muted-foreground border-border";
}

type StatusFilter = "all" | "matches" | "non-matches" | "dismissed";
type SortOption = "default" | "price-asc" | "price-desc" | "name-asc" | "name-desc";

export function ItemsTab({ monitorId, allItems, schema, blacklist, scores, showFilters, onShowFiltersChange }: ItemsTabProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [editedConditions, setEditedConditions] = useState<MatchConditions | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("default");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");

  const updateBlacklist = useMutation(api.monitors.updateBlacklist);
  const submitFeedback = useMutation(api.feedback.submit);
  const clearFeedback = useMutation(api.feedback.clear);
  const feedback = useQuery(api.feedback.forMonitor, { monitorId }) ?? {};

  async function rate(item: ExtractedItem, verdict: "good" | "bad") {
    // Written canonical so the verdict survives the link being re-stamped.
    const key = itemIdentity(item);
    try {
      await submitFeedback({
        monitorId,
        itemKey: key,
        itemTitle: String(item.title ?? item.name ?? key),
        verdict,
        matchScore: scores[itemIdentity(item)]?.matchScore,
      });
      toast.success(verdict === "good" ? "Marked as a good match" : "Hidden — it won't alert you again");
    } catch {
      toast.error("Could not save that");
    }
  }
  const updateMutation = useMutation(api.monitors.update);

  const conditions = editedConditions ?? schema?.matchConditions ?? {};
  const hasEdits = editedConditions !== null;

  // Both forms of every stored key, matching how the scheduler hides them.
  // Entries saved before keys were canonicalised are raw, and an item whose
  // link is re-stamped every scrape would otherwise show here as an ordinary
  // match — Dismiss button and all — while the backend was already
  // suppressing it, and each press would append another near-identical key.
  const blacklistKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const key of blacklist) {
      keys.add(key);
      keys.add(canonicalUrl(key));
    }
    return keys;
  }, [blacklist]);

  const isHidden = useCallback(
    (item: ExtractedItem) =>
      blacklistKeys.has(getItemKey(item)) || blacklistKeys.has(itemIdentity(item)),
    [blacklistKeys]
  );

  const matches = useMemo(() => {
    if (allItems.length === 0) return [];
    return applyMatchConditions(allItems, conditions).filter((item) => !isHidden(item));
  }, [allItems, conditions, isHidden]);

  const matchKeys = useMemo(() => new Set(matches.map(getItemKey)), [matches]);

  const filteredItems = useMemo(() => {
    let items = allItems;

    // Text search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(q));
    }

    // Status filter
    if (statusFilter === "matches") items = items.filter((i) => matchKeys.has(getItemKey(i)));
    else if (statusFilter === "non-matches") items = items.filter((i) => !matchKeys.has(getItemKey(i)) && !isHidden(i));
    else if (statusFilter === "dismissed") items = items.filter((i) => isHidden(i));

    // Price range filter
    const pMin = priceMin ? Number(priceMin) : null;
    const pMax = priceMax ? Number(priceMax) : null;
    if (pMin != null && Number.isFinite(pMin)) {
      items = items.filter((i) => {
        const p = typeof i.price === "number" ? i.price : NaN;
        return !Number.isFinite(p) || p >= pMin; // keep items without prices
      });
    }
    if (pMax != null && Number.isFinite(pMax)) {
      items = items.filter((i) => {
        const p = typeof i.price === "number" ? i.price : NaN;
        return !Number.isFinite(p) || p <= pMax;
      });
    }

    return items;
  }, [allItems, searchQuery, statusFilter, priceMin, priceMax, matchKeys, isHidden]);

  const sortedItems = useMemo(() => {
    return [...filteredItems].sort((a, b) => {
      // User-selected sort takes priority
      if (sortBy === "price-asc" || sortBy === "price-desc") {
        const aP = typeof a.price === "number" ? a.price : sortBy === "price-asc" ? Infinity : -Infinity;
        const bP = typeof b.price === "number" ? b.price : sortBy === "price-asc" ? Infinity : -Infinity;
        return sortBy === "price-asc" ? aP - bP : bP - aP;
      }
      if (sortBy === "name-asc" || sortBy === "name-desc") {
        const aT = String(a.title ?? a.name ?? "").toLowerCase();
        const bT = String(b.title ?? b.name ?? "").toLowerCase();
        return sortBy === "name-asc" ? aT.localeCompare(bT) : bT.localeCompare(aT);
      }
      // Default: matches first, dismissed last
      const aKey = getItemKey(a);
      const bKey = getItemKey(b);
      const aBlack = isHidden(a);
      const bBlack = isHidden(b);
      if (aBlack !== bBlack) return aBlack ? 1 : -1;
      const aMatch = matchKeys.has(aKey);
      const bMatch = matchKeys.has(bKey);
      if (aMatch !== bMatch) return aMatch ? -1 : 1;
      return 0;
    });
  }, [filteredItems, sortBy, matchKeys, isHidden]);

  async function saveConditions() {
    if (!schema || !editedConditions) return;
    setSaving(true);
    try {
      await updateMutation({
        id: monitorId,
        schema: { ...schema, matchConditions: editedConditions },
      });
      setEditedConditions(null);
      trackFilterSaved();
      toast.success("Filters saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  /** Hidden on identity, so the entry stays hidden when its link is re-stamped. */
  async function blacklistItem(item: ExtractedItem) {
    const key = itemIdentity(item);
    if (blacklistKeys.has(key)) return;
    try {
      await updateBlacklist({ id: monitorId, blacklistedItems: [...blacklist, key] });
      trackItemDismissed();
      toast.success("Item dismissed");
    } catch { toast.error("Failed to dismiss"); }
  }

  /**
   * Restoring drops every stored spelling of the entry — a raw key saved
   * before identities were canonicalised sits alongside the canonical one —
   * and retracts the verdict that hid it, so the thumbs data keeps no answer
   * the user took back.
   */
  async function unblacklistItem(key: string) {
    const canonical = canonicalUrl(key);
    try {
      await updateBlacklist({
        id: monitorId,
        blacklistedItems: blacklist.filter((t) => t !== key && canonicalUrl(t) !== canonical),
      });
      await clearFeedback({ monitorId, itemKey: key }).catch(() => {});
      if (canonical !== key) await clearFeedback({ monitorId, itemKey: canonical }).catch(() => {});
      trackItemRestored();
      toast.success("Item restored");
    } catch { toast.error("Failed to restore"); }
  }

  if (allItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Search className="h-8 w-8 text-muted-foreground/40 mb-4" />
        <p className="text-sm text-muted-foreground">No items extracted yet</p>
        <p className="text-xs text-muted-foreground/70 mt-1">Items will appear after the first successful scan</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="text-xs">{filteredItems.length}{filteredItems.length !== allItems.length ? ` of ${allItems.length}` : ""} items</Badge>
          <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
            {matches.length} match{matches.length !== 1 ? "es" : ""}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 sm:w-56 sm:flex-none">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search items..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-8 text-sm"
            />
          </div>
          <Button
            variant={showFilters ? "default" : "outline"}
            size="sm"
            className="gap-1.5 h-8 shrink-0"
            onClick={() => onShowFiltersChange(!showFilters)}
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
          </Button>
        </div>
      </div>

      {/* Quick filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="w-[140px] h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All items</SelectItem>
            <SelectItem value="matches">Matches only</SelectItem>
            <SelectItem value="non-matches">Non-matches</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={(v) => v && setSortBy(v as SortOption)}>
          <SelectTrigger className="w-[150px] h-8 text-xs">
            <ArrowUpDown className="h-3 w-3 mr-1.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Default</SelectItem>
            <SelectItem value="price-asc">Price: low to high</SelectItem>
            <SelectItem value="price-desc">Price: high to low</SelectItem>
            <SelectItem value="name-asc">Name: A–Z</SelectItem>
            <SelectItem value="name-desc">Name: Z–A</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5">
          <div className="relative w-24">
            <TrendingDown className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <Input type="number" placeholder="Min" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} className="pl-7 h-8 text-xs" />
          </div>
          <span className="text-xs text-muted-foreground">–</span>
          <div className="relative w-24">
            <TrendingUp className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <Input type="number" placeholder="Max" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} className="pl-7 h-8 text-xs" />
          </div>
        </div>
        {(statusFilter !== "all" || sortBy !== "default" || priceMin || priceMax) && (
          <Button variant="ghost" size="sm" className="h-8 text-xs gap-1 text-muted-foreground" onClick={() => { setStatusFilter("all"); setSortBy("default"); setPriceMin(""); setPriceMax(""); }}>
            <X className="h-3 w-3" /> Clear
          </Button>
        )}
      </div>

      {/* Match condition editor */}
      {showFilters && schema && (
        <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Edit filters to change which items match. Changes apply instantly below.
              </p>
              {hasEdits && (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditedConditions(null)}>
                    <RotateCcw className="h-3 w-3 mr-1" /> Reset
                  </Button>
                  <Button size="sm" className="h-7 text-xs gap-1" onClick={saveConditions} disabled={saving}>
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                    Save
                  </Button>
                </div>
              )}
            </div>
            <MatchConditionsEditor conditions={conditions} onChange={setEditedConditions} />
            {hasEdits && (
              <p className="text-xs text-primary flex items-center gap-1.5">
                <RefreshCw className="h-3 w-3" />
                Preview active — click Save to keep changes
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Dismissed items */}
      {blacklist.length > 0 && (
        <div className="flex flex-wrap gap-2 py-1">
          <span className="text-xs text-muted-foreground self-center">Dismissed:</span>
          {blacklist.map((key) => (
            <Badge key={key} variant="outline" className="gap-1 pl-2 pr-1 py-0.5 text-xs font-normal max-w-[200px] truncate">
              <Ban className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="truncate">{key}</span>
              <button onClick={() => unblacklistItem(key)} className="ml-0.5 rounded-full hover:bg-muted p-0.5" aria-label={`Restore ${key}`}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Items list */}
      <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
        {sortedItems.map((item, i) => {
          const key = getItemKey(item);
          const title = String(item.title ?? item.name ?? `Item ${i + 1}`);
          const isMatch = matchKeys.has(key);
          const isBlacklisted = isHidden(item);
          const safeUrl = toSafeUrl(item.url);
          const price = formatPrice(item.price, item.currency);
          // Verdicts come from a different scrape than the extract rendered
          // here, so they join on identity rather than on the raw URL.
          const identity = itemIdentity(item);
          const judged = scores[identity];
          const score = judged?.matchScore ?? null;
          const reason = judged?.matchReason ?? "";
          const verdict = feedback[identity];
          const origPrice = formatPrice(item.originalPrice, item.currency);

          return (
            <div
              key={`${key}-${i}`}
              className={`rounded-lg px-3 sm:px-4 py-3 text-sm transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 ${
                isBlacklisted
                  ? "bg-card/10 opacity-30"
                  : isMatch
                    ? "bg-emerald-500/5 border border-emerald-500/20"
                    : "bg-card/30 hover:bg-card/50"
              }`}
            >
              <div className="flex-1 min-w-0 flex items-center gap-2">
                {isMatch && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />}
                {score != null && (
                  <Badge variant="outline" className={`text-[10px] shrink-0 ${confidenceStyle(score)}`}>
                    {MATCH_CONFIDENCE_LABEL[matchConfidence(score)]}
                  </Badge>
                )}
                {safeUrl ? (
                  <a href={safeUrl} target="_blank" rel="noopener noreferrer"
                    className="font-medium hover:text-primary hover:underline transition-colors break-words sm:truncate">
                    {title}
                  </a>
                ) : (
                  <span className="font-medium break-words sm:truncate">{title}</span>
                )}
                {safeUrl && <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />}
              </div>
              {reason && (
                <p className="text-xs text-muted-foreground sm:hidden">{reason}</p>
              )}
              <div className="flex items-center gap-3 shrink-0 self-end sm:self-auto">
                {price && (
                  <span className="font-semibold tabular-nums">{price}</span>
                )}
                {origPrice && origPrice !== price && (
                  <span className="text-xs text-muted-foreground line-through tabular-nums">
                    {origPrice}
                  </span>
                )}
                {(isMatch || isBlacklisted) && (
                  <div className="flex items-center gap-0.5" title={reason || undefined}>
                    <Button
                      variant="ghost" size="sm"
                      className={`h-6 w-6 p-0 ${verdict === "good" ? "text-emerald-400" : "text-muted-foreground"}`}
                      aria-label="Good match" aria-pressed={verdict === "good"}
                      onClick={() => rate(item, "good")}
                    >
                      <ThumbsUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      className={`h-6 w-6 p-0 ${verdict === "bad" ? "text-red-400" : "text-muted-foreground"}`}
                      aria-label="Bad match" aria-pressed={verdict === "bad"}
                      onClick={() => rate(item, "bad")}
                    >
                      <ThumbsDown className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
                {isBlacklisted ? (
                  <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => unblacklistItem(identity)}>
                    Restore
                  </Button>
                ) : isMatch ? (
                  <Button variant="ghost" size="sm" className="h-6 text-xs px-2 text-muted-foreground" onClick={() => blacklistItem(item)}>
                    Dismiss
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
