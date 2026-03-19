"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  Pencil,
  Trash2,
  Clock,
  Globe,
  Zap,
} from "lucide-react";
import type { MockMonitor } from "@/lib/mock-data";
import Link from "next/link";

function timeAgo(timestamp?: number): string {
  if (!timestamp) return "Never";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

interface MonitorCardProps {
  monitor: MockMonitor;
  onTogglePause: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (monitor: MockMonitor) => void;
}

export function MonitorCard({ monitor, onTogglePause, onDelete, onEdit }: MonitorCardProps) {
  return (
    <Card className="group relative overflow-hidden border-border/50 bg-card/50 backdrop-blur transition-all hover:border-border hover:bg-card/80">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <Link
                href={`/dashboard/monitors/${monitor._id}`}
                className="text-base font-semibold truncate hover:text-primary transition-colors"
              >
                {monitor.name}
              </Link>
              <StatusBadge status={monitor.status} />
            </div>

            <p className="text-sm text-muted-foreground line-clamp-1 mb-3">
              &ldquo;{monitor.prompt}&rdquo;
            </p>

            <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
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
                <span className="text-primary font-medium">
                  {monitor.matchCount} match{monitor.matchCount !== 1 && "es"}
                </span>
              )}
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger >
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => window.open(monitor.url, "_blank")}>
                <ExternalLink className="mr-2 h-4 w-4" />
                Open URL
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onEdit(monitor)}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onTogglePause(monitor._id)}>
                {monitor.status === "paused" ? (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="mr-2 h-4 w-4" />
                    Pause
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => onDelete(monitor._id)}
              >
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
