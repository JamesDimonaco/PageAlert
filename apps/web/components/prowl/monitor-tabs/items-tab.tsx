"use client";

import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ExternalLink,
  Search,
  CheckCircle2,
  Ban,
  RotateCcw,
  X,
} from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import type { ExtractedItem } from "@prowl/shared";
import { getItemKey } from "@prowl/shared";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";

interface ItemsTabProps {
  monitorId: Id<"monitors">;
  allItems: ExtractedItem[];
  matches: ExtractedItem[];
  blacklist: string[];
}

export function ItemsTab({ monitorId, allItems, matches, blacklist }: ItemsTabProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const updateBlacklist = useMutation(api.monitors.updateBlacklist);

  const filteredItems = useMemo(() => {
    if (!searchQuery) return allItems;
    const q = searchQuery.toLowerCase();
    return allItems.filter((item) =>
      JSON.stringify(item).toLowerCase().includes(q)
    );
  }, [allItems, searchQuery]);

  const sortedItems = useMemo(() => {
    const matchKeys = new Set(matches.map((m) => getItemKey(m)));
    const blacklistKeys = new Set(blacklist);
    return [...filteredItems].sort((a, b) => {
      const aKey = getItemKey(a);
      const bKey = getItemKey(b);
      const aBlacklisted = blacklistKeys.has(aKey);
      const bBlacklisted = blacklistKeys.has(bKey);
      if (aBlacklisted !== bBlacklisted) return aBlacklisted ? 1 : -1;

      const aMatch = matchKeys.has(aKey);
      const bMatch = matchKeys.has(bKey);
      if (aMatch !== bMatch) return aMatch ? -1 : 1;
      return 0;
    });
  }, [filteredItems, matches, blacklist]);

  async function blacklistItem(key: string) {
    try {
      await updateBlacklist({ id: monitorId, blacklistedItems: [...blacklist, key] });
      toast.success("Item dismissed");
    } catch {
      toast.error("Failed to dismiss");
    }
  }

  async function unblacklistItem(key: string) {
    try {
      await updateBlacklist({ id: monitorId, blacklistedItems: blacklist.filter((t) => t !== key) });
      toast.success("Item restored");
    } catch {
      toast.error("Failed to restore");
    }
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="text-xs">{filteredItems.length} shown</Badge>
          {matches.length > 0 && (
            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
              {matches.length} match{matches.length !== 1 ? "es" : ""}
            </Badge>
          )}
        </div>
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search items..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
        </div>
      </div>

      {/* Blacklisted items */}
      {blacklist.length > 0 && (
        <div className="flex flex-wrap gap-2 pb-2">
          <span className="text-xs text-muted-foreground self-center">Dismissed:</span>
          {blacklist.map((key) => (
            <Badge key={key} variant="outline" className="gap-1.5 pl-2.5 pr-1 py-1 text-xs font-normal max-w-xs truncate">
              <Ban className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="truncate">{key}</span>
              <button
                onClick={() => unblacklistItem(key)}
                className="ml-1 rounded-full hover:bg-muted p-0.5 shrink-0"
                aria-label={`Restore ${key}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Items list */}
      <div className="space-y-2 max-h-[600px] overflow-y-auto">
        {sortedItems.map((item, i) => {
          const key = getItemKey(item);
          const title = String(item.title ?? item.name ?? `Item ${i + 1}`);
          const isMatch = matches.some((m) => getItemKey(m) === key);
          const isBlacklisted = blacklist.includes(key);
          const itemUrl = item.url ? String(item.url) : null;

          return (
            <Card
              key={`${key}-${i}`}
              className={`border-border/30 shadow-sm shadow-black/5 transition-colors ${
                isBlacklisted
                  ? "bg-card/20 opacity-40 border-l-2 border-l-muted-foreground/20"
                  : isMatch
                    ? "bg-emerald-500/5 border-l-2 border-l-emerald-500/40"
                    : "bg-card/30 opacity-60"
              }`}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {itemUrl ? (
                        <a href={itemUrl} target="_blank" rel="noopener noreferrer"
                          className="text-sm font-medium hover:text-primary hover:underline transition-colors truncate">
                          {title}
                        </a>
                      ) : (
                        <p className="text-sm font-medium truncate">{title}</p>
                      )}
                      {itemUrl && <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />}
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      {item.price != null && (
                        <span className="text-sm font-semibold">${Number(item.price).toLocaleString()}</span>
                      )}
                      {item.originalPrice != null && (
                        <span className="text-xs text-muted-foreground line-through">
                          ${Number(item.originalPrice).toLocaleString()}
                        </span>
                      )}
                      {item.savings != null && Number(item.savings) > 0 && (
                        <span className="text-xs text-emerald-400 font-medium">
                          Save ${Number(item.savings).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isBlacklisted ? (
                      <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => unblacklistItem(key)}>
                        <RotateCcw className="h-3 w-3" /> Restore
                      </Button>
                    ) : isMatch ? (
                      <>
                        <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
                          <CheckCircle2 className="h-3 w-3 mr-1" /> Match
                        </Badge>
                        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
                          onClick={() => blacklistItem(key)} title="Dismiss this match">
                          <Ban className="h-3 w-3" /> Dismiss
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
