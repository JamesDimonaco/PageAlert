"use client";

import { useEffect } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Radar } from "lucide-react";
import Link from "next/link";
import { captureException } from "@/lib/posthog";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, error.digest ? { digest: error.digest } : undefined);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-destructive/5 blur-3xl" />
      </div>

      <div className="text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 mx-auto mb-6">
          <Radar className="h-7 w-7 text-destructive/60" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight mb-2">Something went wrong</h1>
        <p className="text-muted-foreground mb-8 max-w-sm mx-auto">
          An unexpected error occurred. This has been reported automatically.
        </p>
        <div className="flex items-center gap-3">
          <Button onClick={reset}>Try again</Button>
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
