"use client";

import { Badge } from "@/components/ui/badge";
import { Mail, MessageCircle, Hash, Bell, Check, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTier } from "@/hooks/use-tier";
import { useCreateMonitor } from "@/hooks/use-create-monitor";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useMonitors } from "@/hooks/use-monitors";
import { toast } from "sonner";

export type Channel = "email" | "telegram" | "discord" | "push";

const CHANNEL_CONFIG: Record<Channel, { label: string; icon: typeof Mail }> = {
  email: { label: "Email", icon: Mail },
  telegram: { label: "Telegram", icon: MessageCircle },
  discord: { label: "Discord", icon: Hash },
  push: { label: "Push", icon: Bell },
};

interface ChannelSelectorProps {
  value: Channel[];
  onChange: (channels: Channel[]) => void;
  /** The monitor ID being edited — null for new monitors */
  monitorId?: string | null;
  disabled?: boolean;
}

export function ChannelSelector({ value, onChange, monitorId, disabled }: ChannelSelectorProps) {
  const router = useRouter();
  const { close: closeSheet } = useCreateMonitor();
  const { tier } = useTier();
  const notifSettings = useQuery(api.notificationSettings.list);
  const pushDevices = useQuery(api.pushSubscriptions.deviceCount);
  const { monitors } = useMonitors();
  const updateMonitor = useMutation(api.monitors.update);

  // Which channels are configured in Settings
  const configuredChannels = new Set<Channel>(
    (notifSettings ?? [])
      .filter((s) => s.enabled)
      .map((s) => s.channel as Channel)
  );
  // Email is always "configured"
  configuredChannels.add("email");
  // Push has no settings row: it is configured once any device is registered
  if ((pushDevices ?? 0) > 0) configuredChannels.add("push");

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
    // Free tier rations Telegram and Discord to one monitor. Email and push
    // are unrestricted — see isRestrictedChannel in convex/monitors.ts.
    if (channel === "email" || channel === "push") return true;
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
          onClick: () => {
            // Close the sheet first so it doesn't stay open over the
            // settings page. The draft is already persisted to
            // localStorage (Phase 3) so nothing is lost.
            closeSheet();
            router.push("/dashboard/settings?tab=notifications");
          },
        },
      });
      return;
    }

    if (!available && tier === "free") {
      // Free user trying to enable on a second monitor — offer to switch
      if (freeMonitorWithChannels) {
        const otherName = (freeMonitorWithChannels as any).name;
        const otherId = freeMonitorWithChannels._id;
        toast(`${CHANNEL_CONFIG[channel].label} is active on "${otherName}". Move it to this monitor?`, {
          duration: 8000,
          action: {
            label: "Switch",
            onClick: async () => {
              try {
                // Remove non-email channels from the other monitor
                const otherChannels = ((freeMonitorWithChannels as any).notificationChannels ?? []) as string[];
                await updateMonitor({
                  id: otherId,
                  notificationChannels: otherChannels.filter((c) => c === "email") as any,
                });
                // Enable on this monitor
                onChange([...value, channel]);
                toast.success(`Switched ${CHANNEL_CONFIG[channel].label} to this monitor`);
              } catch {
                toast.error("Failed to switch channel");
              }
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
        {(["email", "push", "telegram", "discord"] as Channel[]).map((channel) => {
          const config = CHANNEL_CONFIG[channel];
          const Icon = config.icon;
          const isActive = value.includes(channel);
          const isConfigured = configuredChannels.has(channel);
          const available = isChannelAvailable(channel);

          // Free tier: channel is configured but used on another monitor
          const isLockedFree = isConfigured && !available && tier === "free";

          return (
            <button
              key={channel}
              type="button"
              onClick={() => handleToggle(channel)}
              disabled={disabled}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                isLockedFree
                  ? "border-amber-500/30 bg-amber-500/5 text-amber-400 hover:bg-amber-500/10"
                  : isActive
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : isConfigured && available
                      ? "border-border/50 bg-card hover:border-primary/30 hover:bg-primary/5 text-muted-foreground"
                      : "border-border/30 bg-muted/30 text-muted-foreground/50 cursor-default"
              }`}
            >
              <Icon className="h-3 w-3" />
              {config.label}
              {isActive && !isLockedFree && <Check className="h-3 w-3" />}
              {!isConfigured && (
                <Settings className="h-3 w-3 text-muted-foreground/40" />
              )}
              {isLockedFree && (
                <Badge variant="outline" className="text-[9px] px-1 py-0 ml-0.5 border-amber-500/30 text-amber-400">1 monitor</Badge>
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
