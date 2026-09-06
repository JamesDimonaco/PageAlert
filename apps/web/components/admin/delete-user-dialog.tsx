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

export function DeleteUserDialog({
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
  const deleteUser = useMutation(api.admin.deleteUser);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const canDelete = confirmText.trim().toLowerCase() === email.toLowerCase();

  // Clears the confirmation text on any close so re-opening for a
  // different user doesn't start pre-filled with the last one's email.
  function handleOpenChange(next: boolean) {
    if (!next) setConfirmText("");
    onOpenChange(next);
  }

  async function submit() {
    if (!canDelete || busy) return;
    setBusy(true);
    try {
      await deleteUser({ userId, email });
      toast.success(`Deleted ${email} and all their data`);
      handleOpenChange(false);
      onDone?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete user");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {email}</DialogTitle>
          <DialogDescription>
            Permanently deletes the account, monitors, scan history, and sign-in data. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 py-2">
          <Label htmlFor="confirm-email">Type <span className="font-mono">{email}</span> to confirm</Label>
          <Input
            id="confirm-email"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoComplete="off"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={!canDelete || busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
