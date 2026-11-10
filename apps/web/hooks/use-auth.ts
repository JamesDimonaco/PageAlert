"use client";

import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import {
  identifyUser,
  muteForImpersonation,
  resetUser,
  setUserProperties,
  trackSignOut,
  unmuteAfterImpersonation,
} from "@/lib/posthog";
import { clearMonitorDraft } from "@/lib/monitor-draft";

export function useAuth() {
  const session = authClient.useSession();
  const user = session.data?.user ?? null;
  // The admin's user id when an admin is viewing the app as this user.
  const impersonatedBy = session.data?.session.impersonatedBy ?? null;

  // Identify user in PostHog and set properties
  useEffect(() => {
    if (user && impersonatedBy) {
      // Identifying here would merge the admin's browser into this user.
      muteForImpersonation();
    } else if (user) {
      unmuteAfterImpersonation();
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
  }, [user?.id, impersonatedBy]);

  return {
    user,
    session: session.data?.session ?? null,
    impersonatedBy,
    isLoading: session.isPending,
    isAuthenticated: !!user,
    signOut: async () => {
      // Signing out of an impersonation would drop the admin's own session too.
      if (impersonatedBy) {
        await authClient.admin.stopImpersonating();
        window.location.href = "/admin";
        return;
      }
      trackSignOut();
      try {
        await authClient.signOut();
      } catch {
        // Ignore signout errors
      } finally {
        resetUser();
        // Drop any in-progress create-monitor draft so the next user on
        // this browser doesn't inherit it. See PROWL-038 Phase 3.
        clearMonitorDraft();
        window.location.href = "/login";
      }
    },
  };
}
