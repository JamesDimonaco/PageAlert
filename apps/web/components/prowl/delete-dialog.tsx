"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Trash2, Loader2 } from "lucide-react";

interface DeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
  monitorName: string;
}

export function DeleteDialog({ open, onOpenChange, onConfirm, monitorName }: DeleteDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!isDeleting) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive/10">
              <Trash2 className="h-4 w-4 text-destructive" />
            </div>
            Delete Monitor
          </DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <strong>&ldquo;{monitorName}&rdquo;</strong>? This will
            remove all scrape history and cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isDeleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={isDeleting}
            onClick={async () => {
              setIsDeleting(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch (err) {
                if (process.env.NODE_ENV !== "production") {
                  console.error("[DeleteDialog] onConfirm error:", err);
                }
              } finally {
                setIsDeleting(false);
              }
            }}
          >
            {isDeleting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            {isDeleting ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
