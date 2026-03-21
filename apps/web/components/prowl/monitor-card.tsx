"use client";

import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "./status-badge";
import {
  MoreVertical,
  ExternalLink,
  Pause,
  Play,
  Trash2,
  Clock,
  Globe,
  Zap,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import Link from "next/link";
import { useRouter } from "next/navigation";

function timeAgo(timestamp?: number): string {
  if (!timestamp) return "Never";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const isDev = process.env.NODE_ENV === "development";

interface MonitorCardProps {
  monitor: Doc<"monitors">;
  onTogglePause: (id: Id<"monitors">) => void;
  onDelete: (id: Id<"monitors">) => void;
  onRescan?: (id: Id<"monitors">) => void;
}

export function MonitorCard({ monitor, onTogglePause, onDelete, onRescan }: MonitorCardProps) {
  const router = useRouter();

  const statusBorderColor =
    monitor.status === "scanning"
      ? "group-hover:border-l-blue-500/50"
      : monitor.status === "active"
        ? "group-hover:border-l-emerald-500/50"
        : monitor.status === "matched"
          ? "group-hover:border-l-primary/50"
          : monitor.status === "error"
            ? "group-hover:border-l-red-500/50"
            : "group-hover:border-l-amber-500/50";

  return (
    <Card className={`group relative overflow-hidden border-border/30 border-l-2 border-l-transparent bg-card/50 shadow-sm shadow-black/5 backdrop-blur transition-all hover:shadow-md hover:shadow-black/10 hover:bg-card/80 ${statusBorderColor}`}>
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2.5">
              <Link
                href={`/dashboard/monitors/${monitor._id}`}
                className="text-base font-semibold truncate hover:text-primary transition-colors"
              >
                {monitor.name}
              </Link>
              <StatusBadge status={monitor.status} />
            </div>

            <p className="text-sm text-muted-foreground line-clamp-1 mb-4">
              &ldquo;{monitor.prompt}&rdquo;
            </p>

            <div className="flex flex-wrap items-center gap-5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5" />
                <span className="truncate max-w-[200px]">{new URL(monitor.url).hostname}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Every {monitor.checkInterval}
              </span>
              <span className="flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5" />
                Checked {timeAgo(monitor.lastCheckedAt)}
              </span>
              {monitor.matchCount > 0 && (
                <span className="text-primary font-semibold">
                  {monitor.matchCount} match{monitor.matchCount !== 1 && "es"}
                </span>
              )}
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger aria-label="Monitor actions" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-all hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => router.push(`/dashboard/monitors/${monitor._id}`)}>
                <ArrowRight className="mr-2 h-4 w-4" />
                View Details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.open(monitor.url, "_blank")}>
                <ExternalLink className="mr-2 h-4 w-4" />
                Open URL
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onTogglePause(monitor._id)}>
                {monitor.status === "paused" ? (
                  <><Play className="mr-2 h-4 w-4" /> Resume</>
                ) : (
                  <><Pause className="mr-2 h-4 w-4" /> Pause</>
                )}
              </DropdownMenuItem>
              {isDev && onRescan && (
                <DropdownMenuItem onClick={() => onRescan(monitor._id)}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Rescan (dev)
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => onDelete(monitor._id)}>
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );
}
