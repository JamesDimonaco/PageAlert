"use client";

import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./status-badge";
import { AutoPauseNote } from "./auto-pause-note";
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
  Bell,
  BellOff,
  Copy,
} from "lucide-react";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { timeAgo } from "@/lib/time";

const isDev = process.env.NODE_ENV === "development";

interface MonitorCardProps {
  monitor: Doc<"monitors">;
  onTogglePause: (id: Id<"monitors">) => void;
  onDelete: (id: Id<"monitors">) => void;
  onRescan?: (id: Id<"monitors">) => void;
  onClone?: (monitor: Doc<"monitors">) => void;
  onToggleMute?: (id: Id<"monitors">) => void;
}

export function MonitorCard({ monitor, onTogglePause, onDelete, onRescan, onClone, onToggleMute }: MonitorCardProps) {
  const router = useRouter();

  const statusBorderColor =
    monitor.status === "scanning"
      ? "group-hover:border-l-blue-500/50"
      : monitor.status === "active"
        ? "group-hover:border-l-emerald-500/50"
        : monitor.status === "error"
          ? "group-hover:border-l-red-500/50"
          : "group-hover:border-l-amber-500/50";

  const detailHref = `/dashboard/monitors/${monitor._id}`;

  return (
    <Card
      className={`group relative border-l-2 border-l-transparent transition-colors hover:bg-muted/40 ${statusBorderColor}`}
    >
      <CardContent>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2.5">
              <h2 className="min-w-0 text-base font-semibold line-clamp-2">
                <Link href={detailHref} className="outline-none after:absolute after:inset-0 focus-visible:after:rounded-xl focus-visible:after:outline-2 focus-visible:after:outline-ring">
                  {monitor.name}
                </Link>
              </h2>
              <StatusBadge status={monitor.status} />
              {(monitor as any).muted && (
                <Badge variant="outline" className="gap-1 bg-amber-500/10 text-amber-400 border-amber-500/20">
                  <BellOff className="h-3 w-3" />
                  Muted
                </Badge>
              )}
            </div>

            <p className="text-sm text-muted-foreground line-clamp-1 mb-4">
              &ldquo;{monitor.prompt}&rdquo;
            </p>

            {monitor.status === "error" && monitor.lastError && (
              <p className="text-sm text-destructive line-clamp-2 mb-4">{monitor.lastError}</p>
            )}

            {monitor.autoPausedAt !== undefined && (
              <div className="mb-4">
                <AutoPauseNote autoPausedAt={monitor.autoPausedAt} />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
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
                {timeAgo(monitor.lastCheckedAt)}
              </span>
              {(monitor.checkCount ?? 0) > 0 && (
                <span>{monitor.checkCount} check{(monitor.checkCount ?? 0) !== 1 && "s"}</span>
              )}
              {monitor.matchCount > 0 && (
                <span className="text-primary font-semibold">
                  {monitor.matchCount} match{monitor.matchCount !== 1 && "es"}
                </span>
              )}
              {monitor.status === "active" && (monitor.retryCount ?? 0) > 0 && (
                <span className="flex items-center gap-1 text-amber-400">
                  <RefreshCw className="h-3 w-3" />
                  Retrying ({monitor.retryCount}/3)
                </span>
              )}
              {!((monitor as any).muted) && (monitor as any).notificationChannels?.length === 0 && (
                <span className="flex items-center gap-1 text-amber-400">
                  <BellOff className="h-3 w-3" />
                  No alerts
                </span>
              )}
            </div>
          </div>

          <div className="relative z-10">
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="Monitor actions" className="inline-flex h-9 w-9 max-sm:h-11 max-sm:w-11 shrink-0 items-center justify-center rounded-lg border border-border transition-colors hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <MoreVertical className="h-4 w-4" />
              </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => router.push(`/dashboard/monitors/${monitor._id}`)}>
                <ArrowRight className="mr-2 h-4 w-4" />
                Inspect
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
              {onToggleMute && (
                <DropdownMenuItem onClick={() => onToggleMute(monitor._id)}>
                  {(monitor as any).muted ? (
                    <><Bell className="mr-2 h-4 w-4" /> Unmute</>
                  ) : (
                    <><BellOff className="mr-2 h-4 w-4" /> Mute</>
                  )}
                </DropdownMenuItem>
              )}
              {onClone && (
                <DropdownMenuItem onClick={() => onClone(monitor)}>
                  <Copy className="mr-2 h-4 w-4" /> Clone
                </DropdownMenuItem>
              )}
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
        </div>
      </CardContent>
    </Card>
  );
}
