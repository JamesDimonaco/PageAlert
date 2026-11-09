"use client";

import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Radar, ArrowRight } from "lucide-react";
import { authClient } from "@/lib/auth-client";

export function LandingNav() {
  const session = authClient.useSession();
  const isLoggedIn = !session.isPending && !!session.data?.user;

  return (
    <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href={isLoggedIn ? "/dashboard" : "/"} className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Radar className="h-5 w-5 text-primary" />
          </div>
          <span className="text-xl font-bold tracking-tight">PageAlert</span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          {isLoggedIn ? (
            <Link href="/dashboard" className={buttonVariants({ size: "sm", className: "gap-2" })}>
              Go to dashboard
              <ArrowRight className="h-4 w-4" />
            </Link>
          ) : (
            <>
              <Link href="/login" className={buttonVariants({ variant: "ghost", size: "sm", className: "text-muted-foreground hover:text-foreground" })}>
                Sign in
              </Link>
              <Link href="/login" className={buttonVariants({ size: "sm", className: "gap-2" })}>
                Get started
                <ArrowRight className="h-4 w-4 hidden sm:inline" />
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
