"use client";

import { Navbar } from "@/components/prowl/navbar";
import { useAuth } from "@/hooks/use-auth";
import { CreateMonitorProvider } from "@/hooks/use-create-monitor";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isAuthenticated, isLoading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const claimAnonymous = useMutation(api.anonymous.claimMyAnonymousMonitors);
  const claimedRef = useRef(false);
  const banStatus = useQuery(api.account.myBanStatus, isAuthenticated ? {} : "skip");

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      // Preserve the current URL (path + query) so we can come back here
      // after login. This is what makes the email "Try this monitor"
      // deep-link work for logged-out users — the ?try= and ?prompt=
      // params survive the auth detour. See PROWL-038 Phase 4e.
      const qs = searchParams.toString();
      const next = qs ? `${pathname}?${qs}` : pathname;
      const loginUrl = next === "/dashboard" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
      router.replace(loginUrl);
    }
  }, [isLoading, isAuthenticated, router, pathname, searchParams]);

  // Transfer anonymous monitors on first dashboard load
  useEffect(() => {
    if (isAuthenticated && !claimedRef.current) {
      claimedRef.current = true; // Prevent concurrent runs
      let monitorId: string | undefined;
      let anonId: string | undefined;
      try {
        const stored = localStorage.getItem("pagealert_anon_monitor");
        if (stored) {
          const data = JSON.parse(stored);
          monitorId = data.monitorId;
          anonId = data.anonId;
        }
      } catch {
        localStorage.removeItem("pagealert_anon_monitor");
      }

      claimAnonymous({ monitorId: monitorId as Id<"monitors"> | undefined, anonId }).then((result) => {
        localStorage.removeItem("pagealert_anon_monitor");
        if (result.transferred > 0) {
          toast.success(`${result.transferred} monitor${result.transferred !== 1 ? "s" : ""} transferred from your free scan!`);
        }
      }).catch((err) => {
        console.error("[dashboard] Failed to claim anonymous monitors:", err);
        claimedRef.current = false; // Allow retry on next render
      });
    }
  }, [isAuthenticated, claimAnonymous]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) return null;

  if (banStatus?.banned) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold">This account has been suspended</h1>
        {banStatus.reason && <p className="text-sm text-muted-foreground max-w-md">{banStatus.reason}</p>}
        <p className="text-sm text-muted-foreground">Contact support if you believe this is a mistake.</p>
        <Button variant="outline" onClick={signOut}>Sign out</Button>
      </div>
    );
  }

  return (
    <CreateMonitorProvider>
      <div className="flex min-h-screen flex-col">
        <Navbar />
        <main className="flex-1">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-10">{children}</div>
        </main>
      </div>
    </CreateMonitorProvider>
  );
}
