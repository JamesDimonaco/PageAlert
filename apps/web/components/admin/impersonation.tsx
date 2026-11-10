"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

/**
 * Swaps this browser's session for one as the user (Better Auth's admin
 * plugin; an hour long) and reloads into their dashboard. False if it failed;
 * on true the page is already unloading.
 */
export async function startImpersonating(userId: string): Promise<boolean> {
  const { error } = await authClient.admin.impersonateUser({ userId });
  if (error) {
    toast.error(error.message ?? "Could not impersonate this user");
    return false;
  }
  // A full load, not router.push: the Convex client caches the auth token.
  window.location.href = "/dashboard";
  return true;
}

export function ImpersonationBanner({ email }: { email: string }) {
  const [stopping, setStopping] = useState(false);

  async function stop() {
    setStopping(true);
    const { error } = await authClient.admin.stopImpersonating();
    if (error) {
      setStopping(false);
      toast.error(error.message ?? "Could not stop impersonating");
      return;
    }
    // A full load for the same reason as startImpersonating.
    window.location.href = "/admin";
  }

  return (
    <div className="flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-4 py-2 text-sm font-medium text-black">
      <span>
        Viewing as <span className="font-semibold">{email}</span>. Everything you do here is real.
      </span>
      <Button size="sm" variant="outline" onClick={stop} disabled={stopping} className="h-7 border-black/30 bg-transparent text-black hover:bg-black/10">
        {stopping && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Stop impersonating
      </Button>
    </div>
  );
}
