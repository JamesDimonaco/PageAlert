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

const PRESET_DAYS = [7, 14, 30, 90];

export function GrantTrialDialog({
  open,
  onOpenChange,
  userIds,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userIds: string[];
  onDone?: () => void;
}) {
  const grantTrial = useMutation(api.admin.grantTrial);
  const [tier, setTier] = useState<"pro" | "max">("pro");
  const [days, setDays] = useState("14");
  const [busy, setBusy] = useState(false);

  const parsedDays = Number(days);
  const valid = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 365;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const result = await grantTrial({ userIds, tier, days: parsedDays });
      const skipped = result.skippedPaying > 0 ? `, ${result.skippedPaying} skipped (already paying)` : "";
      toast.success(`Granted ${tier} for ${parsedDays} days to ${result.granted} user${result.granted === 1 ? "" : "s"}${skipped}`);
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to grant trial");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Grant a trial</DialogTitle>
          <DialogDescription>
            {userIds.length} user{userIds.length === 1 ? "" : "s"} selected. Anyone already paying is skipped. Existing trials are extended.
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
          </div>
          <div className="grid gap-2">
            <Label htmlFor="trial-days">Days</Label>
            <div className="flex gap-2">
              <Input
                id="trial-days"
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="w-24"
              />
              {PRESET_DAYS.map((d) => (
                <Button key={d} type="button" size="sm" variant={days === String(d) ? "default" : "outline"} onClick={() => setDays(String(d))}>
                  {d}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!valid || busy || userIds.length === 0}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Grant {tier}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
