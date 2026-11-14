"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Check, Folder, FolderMinus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorText } from "@/lib/utils";

export type FolderTarget =
  | { monitorId: Id<"monitors">; name: string; folderId?: Id<"folders"> }
  | { productId: Id<"monitorGroups">; name: string; folderId?: Id<"folders"> };

/** Pick a folder for a monitor or product, take it out of one, or make a new one for it. */
export function MoveToFolderDialog({ target, onClose }: { target: FolderTarget | null; onClose: () => void }) {
  const folders = useQuery(api.folders.list);
  const createFolder = useMutation(api.folders.create);
  const move = useMutation(api.folders.move);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  async function moveTo(folderId: Id<"folders"> | null) {
    if (!target) return;
    setBusy(true);
    try {
      const ids = "monitorId" in target ? { monitorId: target.monitorId } : { productId: target.productId };
      await move({ ...ids, folderId });
      toast.success(folderId ? "Moved to folder" : "Taken out of its folder");
      setNewName("");
      onClose();
    } catch (e) {
      toast.error("Couldn't move it", { description: errorText(e, "Try again.") });
    } finally {
      setBusy(false);
    }
  }

  async function createAndMove() {
    setBusy(true);
    try {
      const folderId = await createFolder({ name: newName });
      await moveTo(folderId);
    } catch (e) {
      toast.error("Couldn't create the folder", { description: errorText(e, "Try again.") });
      setBusy(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move to folder</DialogTitle>
          <DialogDescription>
            Pick a folder for <strong>&ldquo;{target?.name}&rdquo;</strong>. Folders only group your dashboard.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1">
          {(folders ?? []).map((folder) => (
            <li key={folder._id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => moveTo(folder._id)}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
              >
                <Folder className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate">{folder.name}</span>
                {target?.folderId === folder._id && <Check className="h-4 w-4 text-primary" />}
              </button>
            </li>
          ))}
          {target?.folderId && (
            <li>
              <button
                type="button"
                disabled={busy}
                onClick={() => moveTo(null)}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                <FolderMinus className="h-4 w-4" />
                Take out of folder
              </button>
            </li>
          )}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) void createAndMove();
          }}
        >
          <Input
            aria-label="New folder name"
            placeholder="New folder, e.g. PC build"
            value={newName}
            maxLength={100}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Button type="submit" disabled={busy || !newName.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Rename a folder. */
export function RenameFolderDialog({
  folder,
  onClose,
}: {
  folder: { _id: Id<"folders">; name: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={folder !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {/* Keyed so the field starts from this folder's name each time. */}
        {folder && <RenameForm key={folder._id} folder={folder} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({ folder, onClose }: { folder: { _id: Id<"folders">; name: string }; onClose: () => void }) {
  const rename = useMutation(api.folders.rename);
  const [name, setName] = useState(folder.name);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await rename({ id: folder._id, name });
          onClose();
        } catch (err) {
          toast.error("Couldn't rename the folder", { description: errorText(err, "Try again.") });
        } finally {
          setBusy(false);
        }
      }}
      className="space-y-4"
    >
      <DialogHeader>
        <DialogTitle>Rename folder</DialogTitle>
      </DialogHeader>
      <Input aria-label="Folder name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
