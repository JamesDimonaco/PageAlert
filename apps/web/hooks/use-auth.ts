"use client";

import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import { identifyUser, resetUser } from "@/lib/posthog";

export function useAuth() {
  const session = authClient.useSession();
  const user = session.data?.user ?? null;

  // Identify user in PostHog when they log in (no PII sent)
  useEffect(() => {
    if (user) {
      identifyUser(user.id);
    }
  }, [user?.id]);

  return {
    user,
    session: session.data?.session ?? null,
    isLoading: session.isPending,
    isAuthenticated: !!user,
    signOut: async () => {
      try {
        await authClient.signOut();
      } catch {
        // Ignore signout errors
      } finally {
        resetUser();
        window.location.href = "/login";
      }
    },
  };
}
