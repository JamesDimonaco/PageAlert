"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trackWhatsNew } from "@/lib/posthog";

export function WhatsNewDialog() {
  const router = useRouter();
  const entry = useQuery(api.whatsNew.show);
  const dismiss = useMutation(api.whatsNew.dismiss);
  const [closedId, setClosedId] = useState<string | null>(null);
  const shownRef = useRef<string | null>(null);

  const open = !!entry && entry.id !== closedId;

  useEffect(() => {
    if (open && shownRef.current !== entry.id) {
      shownRef.current = entry.id;
      trackWhatsNew({ announcement: entry.id, action: "shown" });
    }
  }, [open, entry]);

  if (!entry) return null;

  function close(action: "dismissed" | "clicked_cta" | "opened_changelog") {
    if (!entry) return;
    setClosedId(entry.id);
    trackWhatsNew({ announcement: entry.id, action });
    void dismiss({ id: entry.id }).catch(() => {});
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close("dismissed")}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{entry.title}</DialogTitle>
          <DialogDescription>{entry.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:items-center">
          <Link
            href="/changelog"
            onClick={() => close("opened_changelog")}
            className="mr-auto text-sm text-muted-foreground hover:text-foreground"
          >
            All updates
          </Link>
          <Button variant="outline" onClick={() => close("dismissed")}>
            {entry.cta ? "Not now" : "Got it"}
          </Button>
          {entry.cta && (
            <Button
              onClick={() => {
                close("clicked_cta");
                router.push(entry.cta!.href);
              }}
            >
              {entry.cta.label}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
