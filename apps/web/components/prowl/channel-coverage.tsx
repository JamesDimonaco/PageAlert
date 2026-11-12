"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { BellRing, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { CoverageUnit, Rollout, RolloutChannel } from "@/convex/monitorChannels";
import { Button, buttonVariants } from "@/components/ui/button";
import { useConfiguredChannels } from "@/components/prowl/channel-selector";
import { errorText } from "@/lib/utils";

/**
 * Getting connected channels onto every monitor. Connecting a channel turns it
 * on everywhere by itself (see convex/monitorChannels.ts); these cover the
 * monitors it still isn't on, because they were turned off by hand or made
 * before the channel was connected.
 */

const NAMES: Record<RolloutChannel, string> = {
  email: "Email",
  push: "Browser alerts",
  telegram: "Telegram",
  discord: "Discord",
};

/**
 * Channels worth nudging about. Email is left out: it's on by default, so a
 * monitor without it is one someone turned it off on.
 */
const NUDGED: RolloutChannel[] = ["push", "telegram", "discord"];

/** Connected channels this page should nudge about, in a fixed order. Undefined while loading. */
function useNudgedChannels(): RolloutChannel[] | undefined {
  const configured = useConfiguredChannels();
  return configured && NUDGED.filter((c) => configured.includes(c));
}

/**
 * Tell the user a channel they just connected went onto their monitors, with
 * an undo. Says nothing when there was nothing to change.
 */
export function useAnnounceRollout() {
  const undo = useMutation(api.monitorChannels.undo);
  return (channel: RolloutChannel, rollout: Rollout | null | undefined) => {
    if (!rollout || (rollout.monitorIds.length === 0 && rollout.groupIds.length === 0)) return;
    toast.success(`${NAMES[channel]} is on for all your monitors`, {
      description: "Turn it off on any monitor from its page.",
      duration: 10000,
      action: {
        label: "Undo",
        onClick: async () => {
          try {
            await undo({ channel, ...rollout });
          } catch (err) {
            toast.error("Couldn't undo that", { description: errorText(err, "Try again.") });
          }
        },
      },
    });
  };
}

function useTurnOn() {
  const turnOn = useMutation(api.monitorChannels.turnOn);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, args: Parameters<typeof turnOn>[0], done: string) => {
    setBusy(key);
    try {
      await turnOn(args);
      toast.success(done);
    } catch (err) {
      toast.error("Couldn't turn that on", { description: errorText(err, "Try again.") });
    } finally {
      setBusy(null);
    }
  };
  return { run, busy };
}

function unitArgs(unit: CoverageUnit) {
  return unit.kind === "product"
    ? { groupId: unit.id as Id<"monitorGroups"> }
    : { monitorId: unit.id as Id<"monitors"> };
}

/**
 * Settings → Notifications: for each connected channel some monitors don't
 * use, how many do and a button to turn it on for the rest. Stays until
 * every monitor has it, unlike the toast it replaced.
 */
export function ChannelCoverageBanner() {
  const units = useQuery(api.monitorChannels.coverage);
  const channels = useNudgedChannels();
  const { run, busy } = useTurnOn();
  if (!units || !channels || units.length === 0) return null;

  const gaps = channels
    .map((channel) => ({ channel, off: units.filter((u) => u.missing.includes(channel)) }))
    .filter((g) => g.off.length > 0);
  if (gaps.length === 0) return null;

  return (
    <div className="space-y-3">
      {gaps.map(({ channel, off }) => (
        <div key={channel} className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <BellRing className="h-4 w-4 text-primary shrink-0 hidden sm:block" />
            <p className="text-sm flex-1">
              {NAMES[channel]} is on for {units.length - off.length} of {units.length}{" "}
              {units.length === 1 ? "monitor" : "monitors"}.
            </p>
            <Button
              size="sm"
              className="shrink-0"
              disabled={busy !== null}
              onClick={() => run(`all:${channel}`, { channel }, `${NAMES[channel]} is on for all your monitors`)}
            >
              Turn on for all
            </Button>
          </div>
          <ul className="divide-y divide-border/30 border-t border-border/30">
            {off.map((unit) => (
              <li key={unit.id} className="flex items-center gap-3 pt-2 [&:not(:first-child)]:pt-2 pb-0.5">
                <p className="text-sm text-muted-foreground flex-1 min-w-0 truncate">
                  {unit.kind === "product" ? `Product: ${unit.name}` : unit.name}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={busy !== null}
                  onClick={() => run(`${unit.id}:${channel}`, { channel, ...unitArgs(unit) }, `${NAMES[channel]} is on for ${unit.name}`)}
                >
                  Turn on
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function dismissKey(id: string) {
  return `pagealert:channel-nudge-dismissed:${id}`;
}

function readDismissed(id: string): boolean {
  try {
    return localStorage.getItem(dismissKey(id)) === "1";
  } catch {
    return false;
  }
}

/**
 * On a monitor or product: a connected channel that's off here, with a
 * button to turn it on. With nothing but email connected, a pointer to set up
 * alerts that reach a phone. Either can be dismissed for this monitor.
 */
export function MonitorChannelNudge({
  monitorId,
  groupId,
}: {
  monitorId?: Id<"monitors">;
  groupId?: Id<"monitorGroups">;
}) {
  const units = useQuery(api.monitorChannels.coverage);
  const channels = useNudgedChannels();
  const { run, busy } = useTurnOn();
  const id = (groupId ?? monitorId) as string | undefined;
  const [dismissed, setDismissed] = useState(() => (id ? readDismissed(id) : false));
  if (!id || !units || !channels || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(dismissKey(id), "1");
    } catch {
      // Private mode: it comes back next visit, which is fine.
    }
  };

  const close = (
    <button
      type="button"
      aria-label="Dismiss"
      onClick={dismiss}
      className="text-muted-foreground hover:text-foreground shrink-0 p-1 -m-1"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );

  if (channels.length === 0) {
    return (
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 flex items-center gap-3">
        <BellRing className="h-4 w-4 text-primary shrink-0" />
        <p className="text-sm flex-1">Get these alerts on your phone, not just by email.</p>
        <Link
          href="/dashboard/settings?tab=notifications"
          className={buttonVariants({ size: "sm", className: "shrink-0" })}
        >
          Set up
        </Link>
        {close}
      </div>
    );
  }

  const unit = units.find((u) => u.id === id);
  const off = unit ? channels.filter((c) => unit.missing.includes(c)) : [];
  if (!unit || off.length === 0) return null;
  const names = off.map((c) => NAMES[c]).join(" and ");

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 flex items-center gap-3">
      <BellRing className="h-4 w-4 text-primary shrink-0" />
      <p className="text-sm flex-1">
        {names} {off.length === 1 ? "is" : "are"} connected but off for this{" "}
        {unit.kind === "product" ? "product" : "monitor"}.
      </p>
      <Button
        size="sm"
        className="shrink-0"
        disabled={busy !== null}
        onClick={async () => {
          for (const channel of off) await run(`${id}:${channel}`, { channel, ...unitArgs(unit) }, `${NAMES[channel]} is on`);
        }}
      >
        Turn on
      </Button>
      {close}
    </div>
  );
}
