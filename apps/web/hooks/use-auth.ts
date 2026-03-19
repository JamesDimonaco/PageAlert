"use client";

import { authClient } from "@/lib/auth-client";

export function useAuth() {
  const session = authClient.useSession();

  return {
    user: session.data?.user ?? null,
    session: session.data?.session ?? null,
    isLoading: session.isPending,
    isAuthenticated: !!session.data?.user,
    signOut: () => authClient.signOut({ fetchOptions: { onSuccess: () => { window.location.href = "/login"; } } }),
  };
}
