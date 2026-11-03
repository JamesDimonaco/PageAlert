"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { FEEDBACK_MAX } from "@/convex/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Kind = "bug" | "idea" | "other";

const KINDS: { value: Kind; label: string; placeholder: string }[] = [
  { value: "bug", label: "Bug", placeholder: "What happened, and what did you expect?" },
  { value: "idea", label: "Idea", placeholder: "What would you like PageAlert to do?" },
  { value: "other", label: "Other", placeholder: "What's on your mind?" },
];

export function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const pathname = usePathname();
  const send = useMutation(api.contact.send);
  const [kind, setKind] = useState<Kind>("bug");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const trimmed = message.trim();

  async function submit() {
    setSending(true);
    try {
      await send({ kind, message: trimmed, page: pathname });
      toast.success("Thanks. James will reply by email.");
      setMessage("");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!sending) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>Found a bug or want a feature? It goes straight to James.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          {KINDS.map((k) => (
            <Button
              key={k.value}
              type="button"
              size="sm"
              variant={kind === k.value ? "default" : "outline"}
              aria-pressed={kind === k.value}
              onClick={() => setKind(k.value)}
            >
              {k.label}
            </Button>
          ))}
        </div>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={KINDS.find((k) => k.value === kind)?.placeholder}
          maxLength={FEEDBACK_MAX}
          rows={6}
          aria-label="Message"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={sending || !trimmed}>
            {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
