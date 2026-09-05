"use client";

import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import type { AuthClient } from "@convex-dev/better-auth/react";
import { ConvexReactClient } from "convex/react";
import { authClient } from "@/lib/auth-client";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({
  children,
  initialToken,
}: {
  children: React.ReactNode;
  initialToken?: string | null;
}) {
  return (
    <ConvexBetterAuthProvider
      client={convex}
      // Cast through unknown: @convex-dev/better-auth 0.12.x's AuthClient type
      // collapses useSession().data to `never` against better-auth >=1.6.16, so
      // no real client is assignable — a .d.ts bug, not a runtime mismatch.
      authClient={authClient as unknown as AuthClient}
      initialToken={initialToken}
    >
      {children}
    </ConvexBetterAuthProvider>
  );
}
