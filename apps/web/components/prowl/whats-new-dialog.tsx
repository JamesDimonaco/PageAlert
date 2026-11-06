"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
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
import { useCreateMonitor } from "@/hooks/use-create-monitor";
import { trackBetaFeatureToggled, trackWhatsNew } from "@/lib/posthog";
import type { BetaFeature } from "@/convex/schema";

export function WhatsNewDialog() {
  const router = useRouter();
  const entry = useQuery(api.whatsNew.show);
  const dismiss = useMutation(api.whatsNew.dismiss);
  const setBetaFeature = useMutation(api.betaFeatures.set);
  const { open: openCreateMonitor } = useCreateMonitor();
  const [closedId, setClosedId] = useState<string | null>(null);
  const [isEnabling, setIsEnabling] = useState(false);
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

  async function enableBeta(feature: BetaFeature) {
    setIsEnabling(true);
    try {
      await setBetaFeature({ feature, enabled: true });
      trackBetaFeatureToggled({ feature, enabled: true });
      close("clicked_cta");
      openCreateMonitor();
    } catch {
      toast.error("Couldn't save that. Try again.");
    } finally {
      setIsEnabling(false);
    }
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
              disabled={isEnabling}
              onClick={() => {
                if (entry.enablesBeta) return void enableBeta(entry.enablesBeta);
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
