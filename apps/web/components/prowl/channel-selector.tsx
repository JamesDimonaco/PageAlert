"use client";

import { Badge } from "@/components/ui/badge";
import { Mail, MessageCircle, Hash, Bell, Check, Settings, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTier } from "@/hooks/use-tier";
import { useCreateMonitor } from "@/hooks/use-create-monitor";
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";

export type Channel = "email" | "telegram" | "discord" | "push" | "sms";

const CHANNEL_CONFIG: Record<Channel, { label: string; icon: typeof Mail }> = {
  email: { label: "Email", icon: Mail },
  sms: { label: "Text", icon: Smartphone },
  telegram: { label: "Telegram", icon: MessageCircle },
  discord: { label: "Discord", icon: Hash },
  push: { label: "Browser", icon: Bell },
};

/** Channels whose availability is a notificationSettings row. Email needs no row, and push is proved by a device. */
const SETTINGS_BACKED: Channel[] = ["telegram", "discord", "sms"];

/**
 * Channels a new monitor does NOT inherit from the account.
 *
 * Every other channel is free to fan out: one more email or push costs
 * nothing. A text costs money and arrives on a phone, so /sms-policy tells
 * carriers "SMS is off by default on every monitor" and that verifying a
 * number alone never produces a text. Seeding it here would make both false.
 */
const NOT_INHERITED: Channel[] = ["sms"];

/** The channels a new or legacy monitor should start with. */
export function defaultChannels(configured: Channel[] | undefined): Channel[] | undefined {
  return configured?.filter((c) => !NOT_INHERITED.includes(c));
}

/**
 * Channels the user has actually set up. Email is always available; push has no
 * settings row, so a registered device is what makes it available.
 *
 * Returns undefined while either query is in flight. Callers seeding defaults
 * must wait for it — falling back to email-only meant a fast page load offered
 * email even when push and Telegram were configured.
 */
export function useConfiguredChannels(): Channel[] | undefined {
  const notifSettings = useQuery(api.notificationSettings.list);
  const pushDevices = useQuery(api.pushSubscriptions.deviceCount);
  return useMemo(() => {
    if (notifSettings === undefined || pushDevices === undefined) return undefined;
    const configured: Channel[] = ["email"];
    if (pushDevices > 0) configured.push("push");
    for (const s of notifSettings) {
      if (s.enabled && (SETTINGS_BACKED as string[]).includes(s.channel)) {
        configured.push(s.channel as Channel);
      }
    }
    return configured;
  }, [notifSettings, pushDevices]);
}

interface ChannelSelectorProps {
  value: Channel[];
  onChange: (channels: Channel[]) => void;
  disabled?: boolean;
}

export function ChannelSelector({ value, onChange, disabled }: ChannelSelectorProps) {
  const router = useRouter();
  const { close: closeSheet } = useCreateMonitor();
  const { tier } = useTier();

  const configuredChannels = new Set<Channel>(useConfiguredChannels() ?? ["email"]);
  const smsEnabled = useQuery(api.sms.isEnabled);

  function handleToggle(channel: Channel) {
    if (disabled) return;

    if (!configuredChannels.has(channel) && !value.includes(channel)) {
      // Discord isn't ready, so there is nothing in Settings to send them to.
      if (channel === "discord") return;
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

    if (value.includes(channel)) {
      onChange(value.filter((c) => c !== channel));
    } else {
      onChange([...value, channel]);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Notification channels</p>
      <div className="flex flex-wrap gap-2">
        {(["email", "sms", "push", "telegram", "discord"] as Channel[])
          // While text alerts are off there is no settings card to send anyone
          // to, so offering the chip would be a dead end. Free has no texts.
          .filter((channel) => channel !== "sms" || (smsEnabled && tier !== "free"))
          .map((channel) => {
          const config = CHANNEL_CONFIG[channel];
          const Icon = config.icon;
          const isActive = value.includes(channel);
          const isConfigured = configuredChannels.has(channel);

          // Discord isn't ready yet. Someone who connected it before keeps it,
          // and a monitor that has it on can still turn it off.
          const comingSoon = channel === "discord" && !isConfigured && !isActive;

          return (
            <button
              key={channel}
              type="button"
              onClick={() => handleToggle(channel)}
              disabled={disabled || comingSoon}
              aria-pressed={isActive}
              className={`inline-flex h-8 max-sm:h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
                comingSoon
                  ? "border-dashed border-border bg-transparent text-muted-foreground/60 cursor-default"
                  : isActive
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : isConfigured
                      ? "border-border bg-card hover:border-primary/30 hover:bg-primary/5 text-muted-foreground"
                      : "border-dashed border-border bg-transparent text-muted-foreground hover:bg-muted/50"
              }`}
            >
              <Icon className="h-3 w-3" />
              {config.label}
              {isActive && <Check className="h-3 w-3" />}
              {comingSoon ? (
                <Badge variant="outline" className="text-xs px-1 py-0 ml-0.5">Soon</Badge>
              ) : (
                !isConfigured && <Settings className="h-3 w-3" />
              )}
            </button>
          );
        })}
      </div>
      {value.length === 0 && (
        <p className="text-xs text-amber-400">No notifications enabled for this monitor</p>
      )}
    </div>
  );
}
