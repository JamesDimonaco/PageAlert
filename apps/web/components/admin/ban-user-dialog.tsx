"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function BanUserDialog({
  open,
  onOpenChange,
  userId,
  email,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  email: string;
  onDone?: () => void;
}) {
  const banUser = useMutation(api.admin.banUser);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  // Clears the draft reason on any close (cancel, escape, backdrop, or a
  // successful ban) so re-opening for a different user starts blank.
  function handleOpenChange(next: boolean) {
    if (!next) setReason("");
    onOpenChange(next);
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await banUser({ userId, email, reason: reason.trim() || undefined });
      toast.success(`Banned ${email}${result.paused > 0 ? ` and paused ${result.paused} monitor${result.paused === 1 ? "" : "s"}` : ""}`);
      handleOpenChange(false);
      onDone?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to ban user");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ban {email}</DialogTitle>
          <DialogDescription>
            Blocks new monitors and dashboard access, and pauses everything they have running. Their data stays put — reverse this any time.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 py-2">
          <Label htmlFor="ban-reason">Reason (optional, shown to the user)</Label>
          <Textarea
            id="ban-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Abusive monitor prompts"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Ban user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
