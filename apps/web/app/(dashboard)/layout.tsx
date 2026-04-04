"use client";

import { Navbar } from "@/components/prowl/navbar";
import { useAuth } from "@/hooks/use-auth";
import { CreateMonitorProvider } from "@/hooks/use-create-monitor";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const claimAnonymous = useMutation(api.anonymous.claimMyAnonymousMonitors);
  const claimedRef = useRef(false);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isLoading, isAuthenticated, router]);

  // Transfer anonymous monitors on first dashboard load
  useEffect(() => {
    if (isAuthenticated && !claimedRef.current) {
      claimedRef.current = true;
      claimAnonymous().then((result) => {
        if (result.transferred > 0) {
          localStorage.removeItem("pagealert_anon_monitor");
          toast.success(`${result.transferred} monitor${result.transferred !== 1 ? "s" : ""} transferred from your free scan!`);
        }
      }).catch(() => {});
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
