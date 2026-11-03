"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, ExternalLink, Loader2, MoreVertical, Pause, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SEARCH_REGIONS, formatMinorUnits } from "@prowl/shared";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/prowl/status-badge";
import { DeleteDialog } from "@/components/prowl/delete-dialog";
import { UpgradeBanner } from "@/components/prowl/upgrade-banner";
import { planNotes, ProductCriteriaForm } from "@/components/prowl/product-criteria-form";
import { useTier } from "@/hooks/use-tier";
import { toSafeUrl } from "@/lib/format";
import { timeAgo } from "@/lib/time";
import { trackListingReviewed, trackMonitorPaused, trackMonitorResumed } from "@/lib/posthog";
import { errorText } from "@/lib/utils";

type Product = NonNullable<ReturnType<typeof useProduct>>;
type Listing = Product["listings"][number];

function useProduct(id: Id<"monitorGroups">) {
  return useQuery(api.monitorGroups.get, { id });
}

const FAILED = "Something went wrong. Try again.";

export default function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const groupId = id as Id<"monitorGroups">;
  const product = useProduct(groupId);
  const monitors = useQuery(api.monitors.list);
  const { tier, resolved: tierResolved, maxMonitors, isLoading: tierLoading } = useTier();
  const watchListing = useMutation(api.monitorGroups.watchListing);
  const unwatchListing = useMutation(api.monitorGroups.unwatchListing);
  const setListingDismissed = useMutation(api.monitorGroups.setListingDismissed);
  const setPaused = useMutation(api.monitorGroups.setPaused);
  const removeProduct = useMutation(api.monitorGroups.remove);
  const router = useRouter();
  const [showDismissed, setShowDismissed] = useState(false);
  const [busyUrls, setBusyUrls] = useState<ReadonlySet<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [unwatching, setUnwatching] = useState<Listing | null>(null);

  if (product === undefined) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (product === null) {
    return (
      <div className="flex flex-col items-center justify-center py-32">
        <p className="text-lg font-semibold mb-2">Product not found</p>
        <Link href="/dashboard">
          <Button variant="outline">Back to dashboard</Button>
        </Link>
      </div>
    );
  }

  const watched = product.listings.filter((l) => l.monitor !== null);
  const dismissedCount = product.listings.filter((l) => l.state === "dismissed").length;
  const shown = product.listings.filter((l) => showDismissed || l.state !== "dismissed");
  const region = SEARCH_REGIONS.find((r) => r.code === product.region)?.name ?? product.region;
  // Every monitor counts toward the plan, paused ones included.
  const full = monitors !== undefined && !tierLoading && monitors.length >= maxMonitors;
  const hasSuggestions = product.listings.some((l) => l.state === "suggested");

  /** Runs one row's action. It may return notes on what the plan changed. */
  async function act(url: string, action: () => Promise<string[] | void>, done: string) {
    setBusyUrls((prev) => new Set(prev).add(url));
    try {
      const notes = await action();
      if (notes && notes.length > 0) toast.warning(done, { description: notes.join(" "), duration: 10000 });
      else toast.success(done);
    } catch (err) {
      toast.error(errorText(err, FAILED));
    } finally {
      setBusyUrls((prev) => {
        const next = new Set(prev);
        next.delete(url);
        return next;
      });
    }
  }

  async function pauseAll(paused: boolean) {
    try {
      const changed = await setPaused({ id: groupId, paused });
      // The same event per monitor as the dashboard's pause button.
      for (let i = 0; i < changed; i++) (paused ? trackMonitorPaused : trackMonitorResumed)();
      toast.success(paused ? "Paused every listing" : "Resumed every listing");
    } catch (err) {
      toast.error(errorText(err, FAILED));
    }
  }

  return (
    <div className="space-y-6">
      <UpgradeBanner tier={tier} tierResolved={tierResolved} atLimit={full} />

      <div className="flex items-center gap-3 overflow-hidden">
        <Link href="/dashboard" className="shrink-0">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight truncate">{product.name}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {region} · watching {watched.length} listing{watched.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border/50 hover:bg-muted transition-colors">
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {watched.some((l) => l.monitor?.status !== "paused") && (
                <DropdownMenuItem onClick={() => void pauseAll(true)}>
                  <Pause className="mr-2 h-4 w-4" /> Pause all
                </DropdownMenuItem>
              )}
              {watched.some((l) => l.monitor?.status === "paused") && (
                <DropdownMenuItem onClick={() => void pauseAll(false)}>
                  <Play className="mr-2 h-4 w-4" /> Resume all
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="mr-2 h-4 w-4" /> Delete product
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="space-y-2">
        {full && hasSuggestions && (
          <p className="text-xs text-muted-foreground">
            You&apos;re using all {maxMonitors} of your monitors. Paused ones still count, so delete one to free a
            slot, or{" "}
            <Link href="/dashboard/settings?tab=billing" className="underline hover:text-foreground">upgrade</Link>.
          </p>
        )}
        <ul className="space-y-2">
          {shown.map((listing) => (
            <ListingRow
              key={listing.url}
              listing={listing}
              busy={busyUrls.has(listing.url)}
              canWatch={!full}
              onWatch={() =>
                act(
                  listing.url,
                  async () => {
                    const got = await watchListing({ id: groupId, url: listing.url });
                    trackListingReviewed(true, { site: listing.site, label: listing.label });
                    return planNotes(
                      product.notificationChannels ?? got.notificationChannels ?? [],
                      got.notificationChannels ?? [],
                      product.checkInterval,
                      got.checkInterval
                    );
                  },
                  `Watching ${listing.site}`
                )
              }
              onUnwatch={() => setUnwatching(listing)}
              onDismiss={() =>
                act(
                  listing.url,
                  async () => {
                    await setListingDismissed({ id: groupId, url: listing.url, dismissed: true });
                    trackListingReviewed(false, { site: listing.site, label: listing.label });
                  },
                  `Dismissed ${listing.site}`
                )
              }
              onRestore={() =>
                act(
                  listing.url,
                  async () => {
                    await setListingDismissed({ id: groupId, url: listing.url, dismissed: false });
                  },
                  `Restored ${listing.site}`
                )
              }
            />
          ))}
        </ul>
        {dismissedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowDismissed(!showDismissed)}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            {showDismissed ? "Hide dismissed" : `Show dismissed (${dismissedCount})`}
          </button>
        )}
      </div>

      <ProductCriteriaForm
        key={product._id}
        group={product}
        listingCurrency={product.listings.find((l) => l.currency)?.currency ?? ""}
        watchingCount={watched.length}
      />

      <DeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete product"
        detail={`This deletes its ${watched.length} monitor${watched.length === 1 ? "" : "s"} and their history, and cannot be undone.`}
        monitorName={product.name}
        onConfirm={async () => {
          try {
            await removeProduct({ id: groupId });
            toast.success("Product deleted");
            router.push("/dashboard");
          } catch (err) {
            toast.error(errorText(err, FAILED));
            throw err;
          }
        }}
      />

      <DeleteDialog
        open={unwatching !== null}
        onOpenChange={(open) => {
          if (!open) setUnwatching(null);
        }}
        title="Stop watching"
        detail="This deletes its monitor and check history, and cannot be undone. The listing stays here as a suggestion."
        monitorName={unwatching?.title ?? ""}
        onConfirm={async () => {
          if (!unwatching) return;
          const { url, site } = unwatching;
          try {
            await unwatchListing({ id: groupId, url });
          } catch (err) {
            toast.error(errorText(err, FAILED));
            throw err;
          }
          toast.success(`Stopped watching ${site}`);
        }}
      />
    </div>
  );
}

function ListingRow({
  listing,
  busy,
  canWatch,
  onWatch,
  onUnwatch,
  onDismiss,
  onRestore,
}: {
  listing: Listing;
  busy: boolean;
  canWatch: boolean;
  onWatch: () => void;
  onUnwatch: () => void;
  onDismiss: () => void;
  onRestore: () => void;
}) {
  const monitor = listing.monitor;
  const seen = monitor?.lastSeen;
  // The monitor's latest read, else what the search found.
  const price =
    seen?.price !== undefined && seen.currency
      ? formatMinorUnits(seen.price, seen.currency)
      : listing.price !== undefined && listing.currency
        ? formatMinorUnits(listing.price, listing.currency)
        : null;
  const inStock = seen?.inStock ?? listing.inStock;
  const href = toSafeUrl(listing.url);

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border/40 bg-card/50 p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {listing.site}
          {href && (
            <a href={href} target="_blank" rel="noopener noreferrer" className="hover:text-foreground" aria-label={`Open ${listing.site}`}>
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </p>
        {listing.monitorId ? (
          <Link href={`/dashboard/monitors/${listing.monitorId}`} className="block text-sm font-medium leading-snug hover:underline">
            {listing.title}
          </Link>
        ) : (
          <p className="text-sm font-medium leading-snug">{listing.title}</p>
        )}
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {price && <span className="font-semibold">{price}</span>}
          {inStock !== undefined && (
            <Badge variant={inStock ? "secondary" : "destructive"}>{inStock ? "In stock" : "Out of stock"}</Badge>
          )}
          {monitor ? (
            <>
              <StatusBadge status={monitor.status} />
              <span className="text-muted-foreground">checked {timeAgo(monitor.lastCheckedAt)}</span>
            </>
          ) : (
            <Badge variant="outline">{listing.state === "dismissed" ? "Dismissed" : "Suggested"}</Badge>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : listing.state === "watching" ? (
          <Button size="sm" variant="outline" onClick={onUnwatch}>Stop watching</Button>
        ) : listing.state === "suggested" ? (
          <>
            <Button size="sm" onClick={onWatch} disabled={!canWatch}>Start watching</Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={onRestore}>Restore</Button>
        )}
      </div>
    </li>
  );
}
