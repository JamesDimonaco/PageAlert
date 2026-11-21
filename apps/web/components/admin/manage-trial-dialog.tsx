"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate } from "./format";

const DAY_MS = 86_400_000;
const EXTEND_DAYS = [7, 14, 30];

export type TrialTarget = { userId: string; email: string; tier: "pro" | "max"; grantUntil: number };

/** Change a live admin trial: move its end date, switch plan, or end it now. */
export function ManageTrialDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: TrialTarget | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Keyed so each opening starts from that user's current trial. */}
        {target && <ManageTrialForm key={target.userId} target={target} onClose={() => onOpenChange(false)} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

function ManageTrialForm({ target, onClose, onDone }: { target: TrialTarget; onClose: () => void; onDone: () => void }) {
  const updateTrial = useMutation(api.admin.updateTrial);
  const endTrial = useMutation(api.admin.endTrial);
  const [tier, setTier] = useState(target.tier);
  const [grantUntil, setGrantUntil] = useState(target.grantUntil);
  const [busy, setBusy] = useState<"save" | "end" | null>(null);

  const changed = tier !== target.tier || grantUntil !== target.grantUntil;
  // Mirrors updateTrial's range, so a bad date shows before Save instead of as an error toast.
  // Read once when the dialog opens; the form remounts on each opening.
  const [now] = useState(() => Date.now());
  const inRange = grantUntil > now && grantUntil <= now + 365 * DAY_MS;

  async function run(kind: "save" | "end") {
    setBusy(kind);
    try {
      if (kind === "save") {
        await updateTrial({ userId: target.userId, tier, grantUntil });
        toast.success(`${target.email}: ${tier} trial until ${formatDate(grantUntil)}`);
      } else {
        await endTrial({ userId: target.userId });
        toast.success(`Ended trial for ${target.email}`);
      }
      onClose();
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update trial");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Manage trial</DialogTitle>
        <DialogDescription>
          {target.email} is on a {target.tier} trial until {formatDate(target.grantUntil)}.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 py-2">
        <div className="grid gap-2">
          <Label>Plan</Label>
          <Select value={tier} onValueChange={(v) => v && setTier(v as "pro" | "max")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pro">Pro</SelectItem>
              <SelectItem value="max">Max</SelectItem>
            </SelectContent>
          </Select>
          {tier === "pro" && target.tier === "max" && (
            <p className="text-xs text-muted-foreground">Monitors checking every 5 minutes move to 15.</p>
          )}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="trial-end">Ends</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="trial-end"
              type="date"
              value={toDateInput(grantUntil)}
              min={toDateInput(now + DAY_MS)}
              max={toDateInput(now + 365 * DAY_MS)}
              onChange={(e) => e.target.value && setGrantUntil(fromDateInput(e.target.value, grantUntil))}
              className="w-40"
            />
            {EXTEND_DAYS.map((d) => (
              <Button key={d} type="button" size="sm" variant="outline" onClick={() => setGrantUntil((g) => g + d * DAY_MS)}>
                +{d}d
              </Button>
            ))}
          </div>
          {!inRange && <p className="text-xs text-destructive">Pick a date between tomorrow and 365 days from now.</p>}
        </div>
      </div>

      <DialogFooter className="sm:justify-between">
        <Button variant="destructive" onClick={() => run("end")} disabled={busy !== null}>
          {busy === "end" && <Loader2 className="h-4 w-4 animate-spin" />}
          End trial now
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy !== null}>Cancel</Button>
          <Button onClick={() => run("save")} disabled={!changed || !inRange || busy !== null}>
            {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

function toDateInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The picked day, at the same time of day the trial ends now. */
function fromDateInput(value: string, keepTimeOf: number): number {
  const [y, m, d] = value.split("-").map(Number);
  const t = new Date(keepTimeOf);
  t.setFullYear(y, m - 1, d);
  return t.getTime();
}
