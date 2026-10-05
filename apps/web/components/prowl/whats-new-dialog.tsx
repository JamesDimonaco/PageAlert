"use client";

import { useEffect, useRef, useState } from "react";
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
  const freeTexts = useQuery(api.whatsNew.show);
  const dismiss = useMutation(api.whatsNew.dismiss);
  const [closed, setClosed] = useState(false);
  const shownRef = useRef(false);

  const open = !!freeTexts && !closed;

  useEffect(() => {
    if (open && !shownRef.current) {
      shownRef.current = true;
      trackWhatsNew({ announcement: "sms-alerts", action: "shown" });
    }
  }, [open]);

  function close(action: "dismissed" | "opened_settings") {
    setClosed(true);
    trackWhatsNew({ announcement: "sms-alerts", action });
    void dismiss({}).catch(() => {});
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close("dismissed")}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>PageAlert can now text you</DialogTitle>
          <DialogDescription>
            Get a text when a monitor finds a match or a price drops. Free accounts get{" "}
            {freeTexts?.month} texts a month, up to {freeTexts?.day} a day.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => close("dismissed")}>
            Not now
          </Button>
          <Button
            onClick={() => {
              close("opened_settings");
              router.push("/dashboard/settings?tab=notifications#sms");
            }}
          >
            Set up texts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
