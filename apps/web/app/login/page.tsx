"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AlertCircle, Radar, Github, Mail, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";
import { trackSignUp, trackSignIn, SIGNED_UP_PARAM } from "@/lib/posthog";

/** Better Auth's default minimum, which convex/betterAuth/auth.ts does not change. */
const MIN_PASSWORD = 8;

/**
 * Only honour `?next=` values that point to a same-origin path. Refuse
 * absolute URLs, protocol-relative URLs, and anything that doesn't start
 * with a single "/" — this is a standard open-redirect guard.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/dashboard";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Set when the server refused what was typed, so the fields are marked. A network failure is not their fault.
  const [refused, setRefused] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextUrl = safeNext(searchParams.get("next"));
  const [isSignUp, setIsSignUp] = useState(searchParams.get("mode") === "signup");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setRefused(false);
    setLoading(true);

    try {
      // Better Auth returns a refused request as `error`; it only throws when the network fails.
      const { error } = isSignUp
        ? await authClient.signUp.email({ email, password, name })
        : await authClient.signIn.email({ email, password });
      if (error) {
        // A rate limit or an outage also comes back as `error`, and is not a wrong password.
        const wrongLogin = !isSignUp && (error.code === "INVALID_EMAIL_OR_PASSWORD" || error.status === 401);
        setRefused(wrongLogin);
        setFormError(
          wrongLogin
            ? "That email or password isn't right."
            : error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" || error.code === "USER_ALREADY_EXISTS"
              ? "That email already has an account. Sign in instead."
              : error.code === "PASSWORD_TOO_SHORT"
                ? `Use a password of at least ${MIN_PASSWORD} characters.`
                : error.code === "INVALID_EMAIL"
                  ? "That email address doesn't look right."
                  : isSignUp
                    ? "We couldn't create your account. Try again."
                    : "We couldn't sign you in. Try again in a moment."
        );
        return;
      }
      if (isSignUp) trackSignUp({ method: "email" });
      else trackSignIn({ method: "email" });
      router.push(nextUrl);
    } catch {
      setFormError("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleOAuth(provider: "google" | "github") {
    setLoading(true);
    try {
      // Better Auth sends only brand-new accounts to newUserCallbackURL, so the
      // marker never reaches a returning user. PostHogProvider reads it.
      const newUserUrl = new URL(nextUrl, window.location.origin);
      newUserUrl.searchParams.set(SIGNED_UP_PARAM, provider);
      await authClient.signIn.social({
        provider,
        callbackURL: nextUrl,
        newUserCallbackURL: `${newUserUrl.pathname}${newUserUrl.search}${newUserUrl.hash}`,
      });
    } catch {
      toast.error(`Failed to sign in with ${provider}`);
      setLoading(false);
    }
  }

  return (
    <main id="main" className="relative flex min-h-screen overflow-hidden items-center justify-center px-4">
      <div className="absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-primary/5 blur-3xl" />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <Link href="/" className="inline-flex items-center gap-2 mb-8">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Radar className="h-5 w-5 text-primary" />
            </div>
            <span className="text-2xl font-bold tracking-tight">PageAlert</span>
          </Link>
        </div>

        <Card className="border-border/30 bg-card/80 shadow-xl shadow-black/10 backdrop-blur">
          <CardHeader className="text-center pb-2 px-8 pt-8">
            <h1 className="text-xl font-bold tracking-tight">{isSignUp ? "Create account" : "Welcome back"}</h1>
            <CardDescription className="mt-1.5 text-sm">
              {isSignUp ? "Sign up to start monitoring" : "Sign in to your account"}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-8 pb-8 pt-6 space-y-6">
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => handleOAuth("google")}
                disabled={loading}
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                </svg>
                Google
              </Button>
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => handleOAuth("github")}
                disabled={loading}
              >
                <Github className="h-4 w-4" />
                GitHub
              </Button>
            </div>

            <div className="relative">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-3 text-xs text-muted-foreground">
                or
              </span>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {isSignUp && (
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-sm font-medium">Name</Label>
                  <Input
                    id="name"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setFormError(null);
                    }}
                    required={isSignUp}
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm font-medium">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setRefused(false);
                    setFormError(null);
                  }}
                  aria-invalid={refused || undefined}
                  aria-describedby={refused ? "login-error" : undefined}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-sm font-medium">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={isSignUp ? "new-password" : "current-password"}
                  minLength={isSignUp ? MIN_PASSWORD : undefined}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setRefused(false);
                    setFormError(null);
                  }}
                  aria-invalid={refused || undefined}
                  aria-describedby={refused ? "login-error" : undefined}
                  required
                />
              </div>
              {formError && (
                <p id="login-error" role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {formError}
                </p>
              )}
              <Button type="submit" className="w-full gap-2 mt-2" disabled={loading}>
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Mail className="h-4 w-4" />
                )}
                {isSignUp ? "Create account" : "Sign in"}
              </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground pt-1">
              {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
              <button
                type="button"
                onClick={() => {
                  setIsSignUp(!isSignUp);
                  setFormError(null);
                  setRefused(false);
                }}
                className="text-primary underline underline-offset-2 font-medium"
              >
                {isSignUp ? "Sign in" : "Sign up"}
              </button>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
