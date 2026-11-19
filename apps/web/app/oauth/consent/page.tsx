"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, Loader2, Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

/** Where the browser goes after the choice. An app picks its own name, so this is what tells the user who is asking. */
function hostOf(url: string | null): string | null {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

export default function ConsentPage() {
  const searchParams = useSearchParams();
  const clientId = searchParams.get("client_id");
  const returnsTo = hostOf(searchParams.get("redirect_uri"));
  const { data: session } = authClient.useSession();
  const [appName, setAppName] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    let stale = false;
    authClient.oauth2.publicClient({ query: { client_id: clientId } }).then(({ data }) => {
      if (!stale && data?.client_name) setAppName(data.client_name);
    });
    return () => {
      stale = true;
    };
  }, [clientId]);

  async function decide(accept: boolean) {
    setError(null);
    setDeciding(accept ? "approve" : "deny");
    // The client plugin sends this page's signed query along, which is how
    // Better Auth knows which request is being answered.
    const { data, error: refused } = await authClient.oauth2.consent({ accept });
    if (refused || !data?.url) {
      setDeciding(null);
      setError("That didn't go through. Go back to your AI app and start the connection again.");
      return;
    }
    window.location.href = data.url;
  }

  const name = appName ?? "An AI app";

  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Radar className="h-5 w-5 text-primary" />
          </div>
          <span className="text-2xl font-bold tracking-tight">PageAlert</span>
        </div>
        <Card>
          <CardHeader className="px-8 pt-8 pb-2 text-center">
            <h1 className="text-xl font-bold tracking-tight">Connect {name}?</h1>
            <CardDescription className="mt-1.5 text-sm">
              {session?.user.email ? `You are signed in as ${session.user.email}.` : "Checking your account…"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 px-8 pb-8 pt-4">
            <div className="space-y-2 text-sm">
              <p>{name} will be able to:</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>See your monitors, products, matches and alerts</li>
                <li>Create, change and delete monitors and products</li>
              </ul>
              <p className="text-muted-foreground">It cannot see your password or change your plan.</p>
            </div>
            {returnsTo && (
              <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                Approving sends you back to <span className="font-mono font-medium">{returnsTo}</span>. Only approve
                if that is the app you came from.
              </p>
            )}
            {error && (
              <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" onClick={() => decide(false)} disabled={deciding !== null}>
                {deciding === "deny" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Deny
              </Button>
              <Button onClick={() => decide(true)} disabled={deciding !== null}>
                {deciding === "approve" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Approve
              </Button>
            </div>
            <p className="text-center text-xs text-muted-foreground">
              You can disconnect it any time in Settings → Connect AI.
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
