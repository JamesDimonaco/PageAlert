import { PauseCircle } from "lucide-react";

/**
 * Why this monitor stopped, when it was the inactivity reaper that stopped it
 * (convex/inactivity.ts) rather than the user. Without it a monitor the user
 * never touched just reads as "Paused" and looks like a bug.
 */
export function AutoPauseNote({ autoPausedAt }: { autoPausedAt?: number }) {
  if (!autoPausedAt) return null;
  const on = new Date(autoPausedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return (
    <p className="flex items-center gap-1.5 text-xs text-amber-400">
      <PauseCircle className="h-3.5 w-3.5 shrink-0" />
      Paused automatically on {on} because you hadn&apos;t been back for a while. Resume to start checking again.
    </p>
  );
}
