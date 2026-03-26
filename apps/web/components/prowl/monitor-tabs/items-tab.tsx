"use client";

import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MatchConditionsEditor } from "@/components/prowl/match-conditions-editor";
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
} from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import type { ExtractedItem, MatchConditions, ExtractionSchema } from "@prowl/shared";
import { applyMatchConditions, getItemKey } from "@prowl/shared";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import { formatPrice, toSafeUrl } from "@/lib/format";

interface ItemsTabProps {
  monitorId: Id<"monitors">;
  allItems: ExtractedItem[];
  schema: ExtractionSchema | undefined;
  blacklist: string[];
}

export function ItemsTab({ monitorId, allItems, schema, blacklist }: ItemsTabProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [editedConditions, setEditedConditions] = useState<MatchConditions | null>(null);
  const [saving, setSaving] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const updateBlacklist = useMutation(api.monitors.updateBlacklist);
  const updateMutation = useMutation(api.monitors.update);

  const conditions = editedConditions ?? schema?.matchConditions ?? {};
  const hasEdits = editedConditions !== null;

  const matches = useMemo(() => {
    if (allItems.length === 0) return [];
    const matched = applyMatchConditions(allItems, conditions);
    return matched.filter((item) => !blacklist.includes(getItemKey(item)));
  }, [allItems, conditions, blacklist]);

  const matchKeys = useMemo(() => new Set(matches.map(getItemKey)), [matches]);
  const blacklistKeys = useMemo(() => new Set(blacklist), [blacklist]);

  const filteredItems = useMemo(() => {
    if (!searchQuery) return allItems;
    const q = searchQuery.toLowerCase();
    return allItems.filter((item) =>
      JSON.stringify(item).toLowerCase().includes(q)
    );
  }, [allItems, searchQuery]);

  const sortedItems = useMemo(() => {
    return [...filteredItems].sort((a, b) => {
      const aKey = getItemKey(a);
      const bKey = getItemKey(b);
      const aBlack = blacklistKeys.has(aKey);
      const bBlack = blacklistKeys.has(bKey);
      if (aBlack !== bBlack) return aBlack ? 1 : -1;
      const aMatch = matchKeys.has(aKey);
      const bMatch = matchKeys.has(bKey);
      if (aMatch !== bMatch) return aMatch ? -1 : 1;
      return 0;
    });
  }, [filteredItems, matchKeys, blacklistKeys]);

  async function saveConditions() {
    if (!schema || !editedConditions) return;
    setSaving(true);
    try {
      await updateMutation({
        id: monitorId,
        schema: { ...schema, matchConditions: editedConditions },
      });
      setEditedConditions(null);
      toast.success("Filters saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function blacklistItem(key: string) {
    try {
      await updateBlacklist({ id: monitorId, blacklistedItems: [...blacklist, key] });
      toast.success("Item dismissed");
    } catch { toast.error("Failed to dismiss"); }
  }

  async function unblacklistItem(key: string) {
    try {
      await updateBlacklist({ id: monitorId, blacklistedItems: blacklist.filter((t) => t !== key) });
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
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="text-xs">{filteredItems.length} items</Badge>
          <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
            {matches.length} match{matches.length !== 1 ? "es" : ""}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-56">
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
            className="gap-1.5 h-8"
            onClick={() => setShowFilters(!showFilters)}
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
          </Button>
        </div>
      </div>

      {/* Collapsible filters */}
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
          const isBlacklisted = blacklistKeys.has(key);
          const safeUrl = toSafeUrl(item.url);
          const price = formatPrice(item.price);
          const origPrice = formatPrice(item.originalPrice);

          return (
            <div
              key={`${key}-${i}`}
              className={`rounded-lg px-4 py-3 text-sm transition-colors flex items-center justify-between gap-3 ${
                isBlacklisted
                  ? "bg-card/10 opacity-30"
                  : isMatch
                    ? "bg-emerald-500/5 border border-emerald-500/20"
                    : "bg-card/30 hover:bg-card/50"
              }`}
            >
              <div className="flex-1 min-w-0 flex items-center gap-2">
                {isMatch && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />}
                {safeUrl ? (
                  <a href={safeUrl} target="_blank" rel="noopener noreferrer"
                    className="font-medium hover:text-primary hover:underline transition-colors truncate">
                    {title}
                  </a>
                ) : (
                  <span className="font-medium truncate">{title}</span>
                )}
                {safeUrl && <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {price && (
                  <span className="font-semibold tabular-nums">{price}</span>
                )}
                {origPrice && origPrice !== price && (
                  <span className="text-xs text-muted-foreground line-through tabular-nums">
                    {origPrice}
                  </span>
                )}
                {isBlacklisted ? (
                  <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => unblacklistItem(key)}>
                    Restore
                  </Button>
                ) : isMatch ? (
                  <Button variant="ghost" size="sm" className="h-6 text-xs px-2 text-muted-foreground" onClick={() => blacklistItem(key)}>
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
