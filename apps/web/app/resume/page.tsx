"use client";

/**
 * The restart link from an inactivity pause email.
 *
 * Deliberately outside the (dashboard) route group so the auth redirect never
 * fires: the whole promise of the email is one click with no sign-in. The
 * resume runs from JavaScript rather than on page load server-side, because
 * mail scanners and link prefetchers fetch every URL in an email and a GET
 * that resumed would restart monitors nobody clicked.
 *
 * The token arrives in the fragment, which browsers never send to the server:
 * out of request logs, and out of the pageview URL PostHog builds from the
 * query string at render. See resumeUrl in convex/emails.ts.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { buttonVariants } from "@/components/ui/button";
import { CheckCircle2, Loader2, Radar } from "lucide-react";
import Link from "next/link";
import { trackEvent } from "@/lib/posthog";

type Result =
  | { status: "working" }
  | { status: "ok"; monitorId: string; name: string; url: string }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "failed" };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function ResumePage() {
  const resume = useMutation(api.monitors.resumeByToken);
  const [result, setResult] = useState<Result>({ status: "working" });
  // The token is single-use, so a second call — React's development double
  // effect, say — would answer "invalid" and overwrite a successful resume.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const raw = window.location.hash.slice(1);
    // Stripped before the token is parsed, not after: decodeURIComponent throws
    // on malformed percent encoding, and a throw here would leave the token in
    // the address bar and the page stuck on "Restarting your monitor…".
    window.history.replaceState(null, "", window.location.pathname);
    let token: string;
    try {
      token = decodeURIComponent(raw);
    } catch {
      token = raw;
    }

    // Every path sets state asynchronously: a synchronous setState in an
    // effect body is a cascading render, and the lint rule says so.
    void (async () => {
      if (!token) {
        setResult({ status: "invalid" });
        return;
      }
      try {
        const r = await resume({ token });
        setResult(r);
        trackEvent("monitor_auto_pause_resumed", { outcome: r.status });
      } catch {
        setResult({ status: "failed" });
      }
    })();
  }, [resume]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-primary/5 blur-3xl" />
      </div>

      <div className="max-w-md text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/5 mx-auto mb-6">
          {result.status === "working" ? (
            <Loader2 className="h-7 w-7 animate-spin text-primary/60" />
          ) : result.status === "ok" ? (
            <CheckCircle2 className="h-7 w-7 text-emerald-500" />
          ) : (
            <Radar className="h-7 w-7 text-primary/60" />
          )}
        </div>

        {result.status === "working" && (
          <p className="text-muted-foreground">Restarting your monitor…</p>
        )}

        {result.status === "ok" && (
          <>
            <h1 className="text-2xl font-bold tracking-tight mb-2">{result.name} is running again</h1>
            <p className="text-muted-foreground mb-8">
              We&apos;ll check {hostOf(result.url)} within the hour.
            </p>
            <Link href={`/dashboard/monitors/${result.monitorId}`} className={buttonVariants()}>
              Open dashboard
            </Link>
          </>
        )}

        {result.status === "invalid" && (
          <>
            <h1 className="text-2xl font-bold tracking-tight mb-2">This link isn&apos;t valid any more</h1>
            <p className="text-muted-foreground mb-8">
              If you want the monitor running, sign in and press Resume.
            </p>
            <Link href="/login" className={buttonVariants()}>Sign in</Link>
          </>
        )}

        {result.status === "expired" && (
          <>
            <h1 className="text-2xl font-bold tracking-tight mb-2">This link has expired</h1>
            <p className="text-muted-foreground mb-8">Sign in to resume the monitor.</p>
            <Link href="/login" className={buttonVariants()}>Sign in</Link>
          </>
        )}

        {result.status === "failed" && (
          <>
            <h1 className="text-2xl font-bold tracking-tight mb-2">Something went wrong</h1>
            <p className="text-muted-foreground mb-8">
              We couldn&apos;t restart the monitor. Try the link again, or sign in and press Resume.
            </p>
            <Link href="/login" className={buttonVariants()}>Sign in</Link>
          </>
        )}
      </div>
    </div>
  );
}
