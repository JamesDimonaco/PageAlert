"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Check, Bell, Plus, Radar, X } from "lucide-react";
import { useMonitors } from "@/hooks/use-monitors";
import { useCreateMonitor } from "@/hooks/use-create-monitor";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRouter } from "next/navigation";
import { trackEvent } from "@/lib/posthog";

const DISMISSED_KEY = "pagealert_checklist_dismissed";

interface ChecklistItem {
  id: string;
  label: string;
  checked: boolean;
  onClick?: () => void;
}

/**
 * Lightweight onboarding checklist shown at the top of the dashboard for
 * new users (≤ 2 monitors). Guides them through: create a monitor, set up
 * notifications (Telegram/Discord), create a second monitor.
 *
 * All state is derived from existing Convex queries — no new tables or
 * fields needed. Dismissible via X button (localStorage).
 *
 * See PROWL-039 Part 2.
 */
export function OnboardingChecklist() {
  const router = useRouter();
  const { monitors } = useMonitors();
  const { open: openCreate } = useCreateMonitor();
  const notifSettings = useQuery(api.notificationSettings.list);

  // Don't render until we have data to avoid layout shift
  const [dismissed, setDismissed] = useState(true); // default hidden
  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISSED_KEY) === "true");
  }, []);

  // Checklist conditions
  const hasMonitor = monitors.length >= 1;
  const hasNotifications = (notifSettings ?? []).some(
    (s) => s.enabled && (s.channel === "telegram" || s.channel === "discord")
  );
  const hasSecondMonitor = monitors.length >= 2;

  const allDone = hasMonitor && hasNotifications && hasSecondMonitor;

  // Don't show if: dismissed, all done, power user (>2 monitors), or still loading
  if (dismissed || monitors.length > 2 || notifSettings === undefined) return null;

  // Auto-dismiss when all items complete — show a brief "all set" then hide
  if (allDone) {
    return (
      <Card className="border-border/30 bg-emerald-500/5 border-emerald-500/20 shadow-sm">
        <CardContent className="px-5 py-4 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/10 shrink-0">
            <Check className="h-4 w-4 text-emerald-400" />
          </div>
          <p className="text-sm font-medium text-emerald-400">
            You&apos;re all set! Your monitors are running and notifications are configured.
          </p>
        </CardContent>
      </Card>
    );
  }

  const items: ChecklistItem[] = [
    {
      id: "create_monitor",
      label: "Create your first monitor",
      checked: hasMonitor,
      onClick: () => openCreate(),
    },
    {
      id: "setup_notifications",
      label: "Set up Telegram or Discord",
      checked: hasNotifications,
      onClick: () => router.push("/dashboard/settings?tab=notifications"),
    },
    {
      id: "second_monitor",
      label: "Create a second monitor",
      checked: hasSecondMonitor,
      onClick: () => openCreate(),
    },
  ];

  const completedCount = items.filter((i) => i.checked).length;

  function handleDismiss() {
    localStorage.setItem(DISMISSED_KEY, "true");
    setDismissed(true);
    trackEvent("onboarding_checklist_dismissed", {
      completed_count: completedCount,
    });
  }

  return (
    <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
      <CardContent className="px-5 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
              <Radar className="h-3.5 w-3.5 text-primary" />
            </div>
            <p className="text-sm font-semibold">Getting started</p>
            <span className="text-xs text-muted-foreground">
              {completedCount}/{items.length}
            </span>
          </div>
          <button
            onClick={handleDismiss}
            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors p-1 -m-1"
            aria-label="Dismiss checklist"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-1">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                if (!item.checked && item.onClick) {
                  trackEvent("onboarding_checklist_item_clicked", { item: item.id });
                  item.onClick();
                }
              }}
              disabled={item.checked}
              className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                item.checked
                  ? "text-muted-foreground"
                  : "hover:bg-muted/50 text-foreground"
              }`}
            >
              <div
                className={`flex h-5 w-5 items-center justify-center rounded-full shrink-0 ${
                  item.checked
                    ? "bg-emerald-500/10"
                    : "border border-border/50"
                }`}
              >
                {item.checked ? (
                  <Check className="h-3 w-3 text-emerald-400" />
                ) : null}
              </div>
              <span className={item.checked ? "line-through" : ""}>
                {item.label}
              </span>
              {!item.checked && (
                <span className="ml-auto text-xs text-muted-foreground">→</span>
              )}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
