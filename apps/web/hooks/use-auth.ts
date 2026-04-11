"use client";

import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import { identifyUser, setUserProperties, resetUser, trackSignOut } from "@/lib/posthog";

export function useAuth() {
  const session = authClient.useSession();
  const user = session.data?.user ?? null;

  // Identify user in PostHog and set properties
  useEffect(() => {
    if (user) {
      identifyUser(user.id, {
        email: user.email,
        name: user.name,
      });
      setUserProperties({
        email: user.email,
        name: user.name,
        created_at: user.createdAt,
        has_image: !!user.image,
      });
    }
  }, [user?.id]);

  return {
    user,
    session: session.data?.session ?? null,
    isLoading: session.isPending,
    isAuthenticated: !!user,
    signOut: async () => {
      trackSignOut();
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
