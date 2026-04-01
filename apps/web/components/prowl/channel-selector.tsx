"use client";

import { Badge } from "@/components/ui/badge";
import { Mail, MessageCircle, Hash, Check, Settings } from "lucide-react";
import { useTier } from "@/hooks/use-tier";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useMonitors } from "@/hooks/use-monitors";
import Link from "next/link";
import { toast } from "sonner";

type Channel = "email" | "telegram" | "discord";

const CHANNEL_CONFIG: Record<Channel, { label: string; icon: typeof Mail }> = {
  email: { label: "Email", icon: Mail },
  telegram: { label: "Telegram", icon: MessageCircle },
  discord: { label: "Discord", icon: Hash },
};

interface ChannelSelectorProps {
  value: Channel[];
  onChange: (channels: Channel[]) => void;
  /** The monitor ID being edited — null for new monitors */
  monitorId?: string | null;
  disabled?: boolean;
}

export function ChannelSelector({ value, onChange, monitorId, disabled }: ChannelSelectorProps) {
  const { tier } = useTier();
  const notifSettings = useQuery(api.notificationSettings.list);
  const { monitors } = useMonitors();

  // Which channels are configured in Settings
  const configuredChannels = new Set<Channel>(
    (notifSettings ?? [])
      .filter((s) => s.enabled)
      .map((s) => s.channel as Channel)
  );
  // Email is always "configured"
  configuredChannels.add("email");

  // For free tier: find if another monitor already uses non-email channels
  const freeMonitorWithChannels = tier === "free"
    ? monitors.find((m) =>
        m._id !== monitorId &&
        (m as any).notificationChannels?.some((c: string) => c === "telegram" || c === "discord")
      )
    : null;

  function isChannelAvailable(channel: Channel): boolean {
    if (!configuredChannels.has(channel)) return false;
    if (tier !== "free") return true;
    // Free tier: non-email channels only if no other monitor is using them
    if (channel === "email") return true;
    if (freeMonitorWithChannels) return false;
    return true;
  }

  function handleToggle(channel: Channel) {
    if (disabled) return;

    const available = isChannelAvailable(channel);

    if (!configuredChannels.has(channel)) {
      toast("Set up " + CHANNEL_CONFIG[channel].label + " in Settings first", {
        action: {
          label: "Go to Settings",
          onClick: () => window.location.href = "/dashboard/settings?tab=notifications",
        },
      });
      return;
    }

    if (!available && tier === "free") {
      // Free user trying to enable on a second monitor
      if (freeMonitorWithChannels) {
        toast(`${CHANNEL_CONFIG[channel].label} is enabled on "${(freeMonitorWithChannels as any).name}". Switch it here?`, {
          action: {
            label: "Switch",
            onClick: () => {
              // Enable here, will need to disable on the other monitor
              // For now just enable — the scheduler enforces the limit server-side
              onChange([...value, channel]);
            },
          },
        });
      }
      return;
    }

    if (value.includes(channel)) {
      onChange(value.filter((c) => c !== channel));
    } else {
      onChange([...value, channel]);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Notification channels</p>
      <div className="flex flex-wrap gap-2">
        {(["email", "telegram", "discord"] as Channel[]).map((channel) => {
          const config = CHANNEL_CONFIG[channel];
          const Icon = config.icon;
          const isActive = value.includes(channel);
          const isConfigured = configuredChannels.has(channel);
          const available = isChannelAvailable(channel);

          return (
            <button
              key={channel}
              type="button"
              onClick={() => handleToggle(channel)}
              disabled={disabled}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : isConfigured && available
                    ? "border-border/50 bg-card hover:border-primary/30 hover:bg-primary/5 text-muted-foreground"
                    : "border-border/30 bg-muted/30 text-muted-foreground/50 cursor-default"
              }`}
            >
              <Icon className="h-3 w-3" />
              {config.label}
              {isActive && <Check className="h-3 w-3" />}
              {!isConfigured && (
                <Settings className="h-3 w-3 text-muted-foreground/40" />
              )}
              {isConfigured && !available && tier === "free" && (
                <Badge variant="outline" className="text-[9px] px-1 py-0 ml-0.5">1 monitor</Badge>
              )}
            </button>
          );
        })}
      </div>
      {value.length === 0 && (
        <p className="text-[10px] text-amber-400">No notifications enabled for this monitor</p>
      )}
    </div>
  );
}
