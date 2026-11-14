"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, FolderInput, Package, Tag, Zap } from "lucide-react";
import { formatMinorUnits } from "@prowl/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./status-badge";
import type { Doc } from "@/convex/_generated/dataModel";
import type { ProductSummary } from "@/convex/monitorGroups";
import { timeAgo } from "@/lib/time";

interface ProductCardProps {
  product: ProductSummary;
  monitors: Doc<"monitors">[];
  onMoveToFolder?: () => void;
}

export function ProductCard({ product, monitors, onMoveToFolder }: ProductCardProps) {
  const [open, setOpen] = useState(false);
  const detailHref = `/dashboard/products/${product._id}`;
  const { cheapest } = product;
  const cheapestPrice = cheapest && formatMinorUnits(cheapest.price, cheapest.currency);

  return (
    <Card className="group relative border-l-2 border-l-transparent transition-colors hover:bg-muted/40 hover:border-l-primary/50 focus-within:border-l-primary/50">
      <CardContent>
        <div className="flex flex-wrap items-center gap-3 mb-2.5">
          <Package className="h-4 w-4 text-muted-foreground" />
          <h2 className="min-w-0 text-base font-semibold line-clamp-2">
            <Link href={detailHref} className="outline-none after:absolute after:inset-0 focus-visible:after:rounded-xl focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring">
              {product.name}
            </Link>
          </h2>
          {product.inStock !== null && (
            <Badge
              variant="outline"
              className={product.inStock
                ? "bg-emerald-500/10 text-success border-emerald-500/20"
                : "bg-muted text-muted-foreground"}
            >
              {product.inStock ? "In stock" : "Out of stock"}
            </Badge>
          )}
          {product.paused > 0 && (
            <Badge variant="outline" className="bg-amber-500/10 text-warning border-amber-500/20">
              {product.paused} paused
            </Badge>
          )}
          {product.errored > 0 && (
            <Badge variant="outline" className="bg-red-500/10 text-destructive border-red-500/20">
              {product.errored} with errors
            </Badge>
          )}
          {onMoveToFolder && (
            <button
              type="button"
              aria-label="Move to folder"
              title="Move to folder"
              onClick={onMoveToFolder}
              className="relative z-10 ml-auto inline-flex h-9 w-9 max-sm:h-11 max-sm:w-11 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <FolderInput className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span>Watching {product.watching} listing{product.watching !== 1 && "s"}</span>
          {cheapest && cheapestPrice && (
            <span className="flex items-center gap-1.5">
              <Tag className="h-3.5 w-3.5" />
              <span className="font-semibold text-foreground">{cheapestPrice}</span> at {cheapest.site}
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5" />
            {timeAgo(product.lastCheckedAt)}
          </span>
          {monitors.length > 0 && (
            <button
              type="button"
              aria-expanded={open}
              className="relative z-10 ml-auto flex h-8 max-sm:h-11 items-center gap-1 rounded-md px-2 hover:bg-muted hover:text-foreground"
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "Hide listings" : "Show listings"}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
          )}
        </div>

        {open && (
          <ul className="relative z-10 mt-4 divide-y divide-border/30 border-t border-border/30">
            {monitors.map((m) => (
              <li key={m._id}>
                <Link
                  href={`/dashboard/monitors/${m._id}`}
                  className="flex items-center gap-3 py-2.5 text-sm hover:text-primary"
                >
                  <span className="flex-1 min-w-0 truncate">{new URL(m.url).hostname}</span>
                  {m.lastSeen?.price !== undefined && m.lastSeen.currency && (
                    <span className="text-xs text-muted-foreground">
                      {formatMinorUnits(m.lastSeen.price, m.lastSeen.currency)}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">{timeAgo(m.lastCheckedAt)}</span>
                  <StatusBadge status={m.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
