"use client";

import { useState, useEffect } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { User, Bell, CreditCard, Trash2, Loader2, ExternalLink, Sparkles, KeyRound } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { useMonitors } from "@/hooks/use-monitors";
import { useTier } from "@/hooks/use-tier";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";
import {
  POSTHOG_KEY,
  trackBetaFeatureToggled,
  trackUpgradePromptClicked,
} from "@/lib/posthog";
import { AnalyticsToggle } from "@/components/prowl/analytics-toggle";
import { ApiKeysCard } from "@/components/prowl/api-keys-card";
import { NotificationSettings } from "@/components/prowl/notification-settings";

const VALID_TABS = ["notifications", "profile", "billing", "api"] as const;
type SettingsTab = (typeof VALID_TABS)[number];

export default function SettingsPage() {
  const { user, signOut } = useAuth();
  const { monitors } = useMonitors();
  const { tier, maxMonitors, description: tierDescription, isLoading: tierLoading, refetch: refetchTier, isCancelled, daysRemaining, periodEnd, grantUntil, grantSource } = useTier();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");

  // Tab state — driven by ?tab= so deep-links (e.g. from the channel-selector
  // toast) land on the right tab. Falls back to "notifications" if missing/invalid.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tabFromQuery = searchParams.get("tab");
  const initialTab: SettingsTab = (VALID_TABS as readonly string[]).includes(tabFromQuery ?? "")
    ? (tabFromQuery as SettingsTab)
    : "notifications";
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  // A link to ?tab= while Settings is already open (the what's-new dialog sits
  // on every dashboard page) changes the URL without remounting, so follow it.
  const [lastTabFromQuery, setLastTabFromQuery] = useState(tabFromQuery);
  if (tabFromQuery !== lastTabFromQuery) {
    setLastTabFromQuery(tabFromQuery);
    setActiveTab(initialTab);
  }

  function handleTabChange(value: string) {
    setActiveTab(value as SettingsTab);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  // Show success toast after returning from Polar checkout
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.search.includes("upgraded=true")) {
      toast.success("Welcome to your new plan!", { description: "Your subscription is now active." });
      refetchTier();
      const timer = setTimeout(() => {
        window.history.replaceState({}, "", "/dashboard/settings");
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [refetchTier]);

  const [isCheckingOut, setIsCheckingOut] = useState(false);

  async function handleCheckout(slug: "sprint" | "pro" | "max") {
    if (isCheckingOut) return;
    setIsCheckingOut(true);
    trackUpgradePromptClicked({ plan: slug, currentTier: tier });
    try {
      await authClient.checkout({ slug });
    } catch {
      toast.error("Checkout unavailable", { description: "Billing is not configured yet" });
    } finally {
      setIsCheckingOut(false);
    }
  }

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteAccountMutation = useMutation(api.account.deleteAccount);
  const notifSettings = useQuery(api.notificationSettings.list);
  const betaFeatures = useQuery(api.betaFeatures.list);
  const setBetaFeature = useMutation(api.betaFeatures.set);
  const findAProductOn = betaFeatures?.includes("find_a_product") ?? false;

  const isPass = grantSource === "pass" && !!grantUntil;
  // A grant isn't a Polar subscription, so the portal has nothing to manage —
  // the checkout/portal gates key off this, not the raw (possibly granted)
  // tier. A bought pass is still a purchase, so it doesn't read as free.
  const paidTier = grantUntil && !isPass ? "free" : tier;
  // A trial user is offered the plan they're trialling and above, never a downgrade
  // A pass is a purchase but not a subscription, so its holder should still be
  // offered Pro (and has nothing for the Polar portal to manage).
  const offerPro = (paidTier === "free" || isPass) && tier !== "max";
  const offerMax = paidTier === "pro" || (!!grantUntil && tier === "max");
  const hasSubscription = paidTier !== "free" && !grantUntil;

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">Manage your account and preferences</p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="notifications" className="relative">
            <Bell className="hidden sm:block" />
            Notifications
            {notifSettings && notifSettings.filter((s) => s.enabled).length === 0 && (
              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-400" />
            )}
          </TabsTrigger>
          <TabsTrigger value="profile">
            <User className="hidden sm:block" />
            Profile
          </TabsTrigger>
          <TabsTrigger value="billing">
            <CreditCard className="hidden sm:block" />
            Billing
          </TabsTrigger>
          <TabsTrigger value="api">
            <KeyRound className="hidden sm:block" />
            API
          </TabsTrigger>
        </TabsList>

        <TabsContent value="api" className="mt-8 space-y-8">
          <ApiKeysCard />
        </TabsContent>

        <TabsContent value="profile" className="mt-8 space-y-8">
          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg font-semibold">Profile</CardTitle>
              <CardDescription className="text-sm">Your account information</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="name" className="text-sm font-medium">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="settings-email" className="text-sm font-medium">Email</Label>
                <Input
                  id="settings-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="pt-2">
                <Button onClick={() => toast.success("Profile updated")}>
                  Save changes
                </Button>
              </div>
            </CardContent>
          </Card>

          {POSTHOG_KEY && (
            <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg font-semibold">Analytics</CardTitle>
                <CardDescription className="text-sm">How we see what the app is used for</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <AnalyticsToggle />
                <Link href="/privacy" className="text-xs text-primary hover:underline">
                  Privacy policy
                </Link>
              </CardContent>
            </Card>
          )}

          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg font-semibold">Beta features</CardTitle>
              <CardDescription className="text-sm">Try things before everyone else gets them</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">Find a product</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Type a product name and pick the shops to watch. It&apos;s an early version, so expect rough edges.
                  </p>
                </div>
                <Button
                  variant={findAProductOn ? "outline" : "default"}
                  size="sm"
                  disabled={betaFeatures === undefined}
                  className="shrink-0"
                  onClick={async () => {
                    const enabled = !findAProductOn;
                    try {
                      await setBetaFeature({ feature: "find_a_product", enabled });
                      trackBetaFeatureToggled({ feature: "find_a_product", enabled });
                    } catch {
                      toast.error("Couldn't save that. Try again.");
                    }
                  }}
                >
                  {betaFeatures === undefined ? "Loading" : findAProductOn ? "Turn off" : "Turn on"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border-destructive/20 bg-card/50 shadow-sm shadow-black/5">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg font-semibold text-destructive">Danger Zone</CardTitle>
              <CardDescription className="text-sm">
                Permanently delete your account, your sign-in, and all data including monitors, scrape history, and notification settings.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" onClick={() => setDeleteOpen(true)}>Delete account</Button>
              <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive/10">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </div>
                      Delete Account
                    </DialogTitle>
                    <DialogDescription>
                      This will permanently delete your sign-in and everything attached to it —
                      every monitor, scrape result, notification setting, and the record of
                      emails we sent you. Signing up again starts from scratch. This cannot be
                      undone.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="ghost" onClick={() => setDeleteOpen(false)} disabled={isDeleting}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={isDeleting}
                      onClick={async () => {
                        setIsDeleting(true);
                        try {
                          await deleteAccountMutation();
                          toast.success("Account deleted");
                          await signOut();
                        } catch {
                          toast.error("Failed to delete account");
                        } finally {
                          setIsDeleting(false);
                        }
                      }}
                    >
                      {isDeleting ? "Deleting..." : "Delete everything"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="mt-8">
          <NotificationSettings />
        </TabsContent>

        <TabsContent value="billing" className="mt-8 space-y-8">
          {tierLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (<>
          {grantUntil && tier !== "free" && (
            <Card className="border-primary/30 bg-primary/5 shadow-sm">
              <CardContent className="p-4 sm:p-5">
                <p className="text-sm font-semibold text-primary">
                  {isPass
                    ? "Your Sprint pass is running"
                    : `You're on a free ${tier.charAt(0).toUpperCase() + tier.slice(1)} trial`}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {isPass ? (
                    <>
                      It ends on {new Date(grantUntil).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} and
                      nothing renews — you go back to free unless you buy another
                      pass or subscribe.
                    </>
                  ) : (
                    <>
                      Trial ends {new Date(grantUntil).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}. Upgrade below to keep {tier.charAt(0).toUpperCase() + tier.slice(1)} after that.
                    </>
                  )}
                </p>
              </CardContent>
            </Card>
          )}
          {/* Cancellation banner */}
          {isCancelled && tier !== "free" && (
            <Card className="border-amber-500/30 bg-amber-500/5 shadow-sm">
              <CardContent className="p-4 sm:p-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-amber-400">
                      Your {tier.charAt(0).toUpperCase() + tier.slice(1)} plan has been cancelled
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {daysRemaining !== null && daysRemaining > 0
                        ? `You have access until ${new Date(periodEnd!).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} (${daysRemaining} day${daysRemaining !== 1 ? "s" : ""} remaining).`
                        : "Your access has expired."}
                    </p>
                    <p className="text-xs text-muted-foreground/70 mt-1">
                      Your monitors will continue running until then. After that, you&apos;ll be on the free plan.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="gap-1.5 shrink-0"
                    onClick={async () => {
                      try {
                        await authClient.customer.portal();
                      } catch {
                        toast.error("Portal unavailable");
                      }
                    }}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Resubscribe
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Current Plan */}
          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg font-semibold">Current Plan</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3">
                    <p className="text-xl font-bold capitalize">{tier}</p>
                    {isCancelled ? (
                      <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-400 border-amber-500/20">Cancelling</Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">Current plan</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                    {tierDescription}
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  {offerPro && (
                    <Button
                      className="gap-1.5 shadow-md shadow-primary/15"
                      onClick={() => handleCheckout("pro")}
                    >
                      <Sparkles className="h-4 w-4" />
                      Upgrade to Pro
                    </Button>
                  )}
                  {offerMax && (
                    <Button
                      className="gap-1.5 shadow-md shadow-primary/15"
                      onClick={() => handleCheckout("max")}
                    >
                      <Sparkles className="h-4 w-4" />
                      Upgrade to Max
                    </Button>
                  )}
                  {hasSubscription && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={async () => {
                        try {
                          await authClient.customer.portal();
                        } catch {
                          toast.error("Portal unavailable");
                        }
                      }}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Manage Subscription
                    </Button>
                  )}
                </div>
              </div>
              {hasSubscription && (
                <p className="text-xs text-muted-foreground mt-4">
                  Manage your billing, update payment method, or cancel your subscription from the Polar portal.
                  {" "}You&apos;ll be redirected to Polar — close the tab to return here.
                  {!isCancelled && " If you cancel, you'll keep access until the end of your billing period."}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Upgrade Options */}
          {offerPro && (
            <div className="grid gap-4 md:grid-cols-3">
              {!isPass && (
                <Card className="border-border/30 bg-card/50 shadow-sm">
                  <CardContent className="p-6">
                    <h3 className="text-lg font-bold mb-3">Sprint pass</h3>
                    <p className="text-3xl font-bold">
                      $4<span className="text-sm font-normal text-muted-foreground"> once</span>
                    </p>
                    <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                      <li>10 monitors</li>
                      <li>30 minute checks</li>
                      <li>30 days, then it stops</li>
                    </ul>
                    <Button
                      variant="outline"
                      className="w-full mt-4"
                      disabled={isCheckingOut}
                      onClick={() => handleCheckout("sprint")}
                    >
                      Buy a pass
                    </Button>
                  </CardContent>
                </Card>
              )}
              <Card className="border-primary/30 bg-primary/5 shadow-sm">
                <CardContent className="p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="text-lg font-bold">Pro</h3>
                    <Badge className="bg-primary/10 text-primary border-primary/20 text-xs">Popular</Badge>
                  </div>
                  <p className="text-3xl font-bold">$9<span className="text-sm font-normal text-muted-foreground">/mo</span></p>
                  <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                    <li>25 monitors</li>
                    <li>15 minute checks</li>
                    <li>All notification channels</li>
                  </ul>
                  <Button
                    className="w-full mt-4 gap-1.5"
                    onClick={() => handleCheckout("pro")}
                  >
                    <Sparkles className="h-4 w-4" />
                    Upgrade to Pro
                  </Button>
                </CardContent>
              </Card>
              <Card className="border-border/30 bg-card/50 shadow-sm">
                <CardContent className="p-6">
                  <h3 className="text-lg font-bold mb-3">Max</h3>
                  <p className="text-3xl font-bold">$29<span className="text-sm font-normal text-muted-foreground">/mo</span></p>
                  <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                    <li>Unlimited monitors</li>
                    <li>5 minute checks</li>
                    <li>Everything in Pro</li>
                  </ul>
                  <Button
                    variant="outline"
                    className="w-full mt-4 gap-1.5"
                    onClick={() => handleCheckout("max")}
                  >
                    Upgrade to Max
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Pro → Max upgrade */}
          {offerMax && (
            <Card className="border-border/30 bg-card/50 shadow-sm">
              <CardContent className="p-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-bold">Need more?</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Max gives you unlimited monitors, 5 minute checks, and everything coming soon.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className="gap-1.5 shrink-0"
                    onClick={() => handleCheckout("max")}
                  >
                    <Sparkles className="h-4 w-4" />
                    Upgrade to Max — $29/mo
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Usage */}
          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg font-semibold">Usage</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="font-medium">Monitors</span>
                    <span className="text-muted-foreground tabular-nums">{monitors.length} / {maxMonitors}</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${monitors.length > maxMonitors ? "bg-amber-500" : "bg-primary"}`}
                      style={{ width: `${Math.min((monitors.length / maxMonitors) * 100, 100)}%` }}
                    />
                  </div>
                  {monitors.length >= maxMonitors && (
                    <p className="text-xs text-amber-400 mt-2 font-medium">
                      {monitors.length > maxMonitors ? "Over limit — upgrade to add more" : "At limit — upgrade for more monitors"}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
          </>)}
        </TabsContent>
      </Tabs>
    </div>
  );
}
