"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { User, Bell, CreditCard, Mail, MessageCircle, Hash, Trash2, Send, CheckCircle2, Loader2, ExternalLink, Sparkles, Lock } from "lucide-react";
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
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";
import {
  trackUpgradePromptClicked,
  trackTestEmailSent,
  trackNotificationChannelToggled,
} from "@/lib/posthog";

type NotificationChannel = "email" | "telegram" | "discord";

export default function SettingsPage() {
  const { user, signOut } = useAuth();
  const { monitors } = useMonitors();
  const { tier, maxMonitors, description: tierDescription, isLoading: tierLoading, refetch: refetchTier, isCancelled, daysRemaining, periodEnd } = useTier();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");

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

  async function handleCheckout(slug: "pro" | "max") {
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

  const [emailNotifs, setEmailNotifs] = useState(true);
  const [telegramChatId, setTelegramChatId] = useState("");
  const [discordWebhook, setDiscordWebhook] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [telegramQrOpen, setTelegramQrOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [testEmailSending, setTestEmailSending] = useState(false);
  const [testEmailSent, setTestEmailSent] = useState(false);
  const [telegramSaving, setTelegramSaving] = useState(false);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [discordSaving, setDiscordSaving] = useState(false);
  const deleteAccountMutation = useMutation(api.account.deleteAccount);
  const sendTestEmail = useAction(api.notifications.sendTestEmail);
  const upsertSetting = useMutation(api.notificationSettings.upsert);
  const removeSetting = useMutation(api.notificationSettings.remove);
  const sendTelegramTest = useAction(api.telegram.sendTestMessage);
  const sendDiscordTest = useAction(api.discord.sendTestMessage);
  const updateMonitor = useMutation(api.monitors.update);
  const notifSettings = useQuery(api.notificationSettings.list);

  // Sync settings from DB to local state on first load only
  const settingsSyncedRef = useRef(false);
  useEffect(() => {
    if (notifSettings && !settingsSyncedRef.current) {
      settingsSyncedRef.current = true;
      const tg = notifSettings.find((s: { channel: string }) => s.channel === "telegram");
      if (tg) setTelegramChatId(tg.target);
      const dc = notifSettings.find((s: { channel: string }) => s.channel === "discord");
      if (dc) setDiscordWebhook(dc.target);
    }
  }, [notifSettings]);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">Manage your account and preferences</p>
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">
            <User className="mr-2 h-4 w-4" />
            Profile
          </TabsTrigger>
          <TabsTrigger value="notifications" className="relative">
            <Bell className="mr-2 h-4 w-4" />
            Notifications
            {notifSettings && notifSettings.filter((s) => s.enabled).length === 0 && (
              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-400" />
            )}
          </TabsTrigger>
          <TabsTrigger value="billing">
            <CreditCard className="mr-2 h-4 w-4" />
            Billing
          </TabsTrigger>
        </TabsList>

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

          <Card className="border-destructive/20 bg-card/50 shadow-sm shadow-black/5">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg font-semibold text-destructive">Danger Zone</CardTitle>
              <CardDescription className="text-sm">
                Permanently delete your account and all data including monitors, scrape history, and notification settings.
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
                      This will permanently delete your account and all associated data including
                      all monitors, scrape results, and notification settings. This cannot be undone.
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

        <TabsContent value="notifications" className="mt-8 space-y-8">
          <div className="rounded-lg border border-border/20 bg-muted/30 px-4 py-3">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Notifications are sent for <strong className="text-foreground">all your monitors </strong>when new matches are found or errors occur.
              Enable any channels below and they&apos;ll all receive alerts.
              {tier === "free" && " Upgrade to Pro for Telegram and Discord."}
            </p>
          </div>

          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <Mail className="h-5 w-5 text-muted-foreground" />
                Email Notifications
              </CardTitle>
              <CardDescription className="text-sm">
                Get notified at your account email when monitors find matches or encounter errors
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium break-all">{email}</p>
                  <p className="text-xs text-muted-foreground mt-1">Match alerts and error notifications</p>
                </div>
                <Button
                  variant={emailNotifs ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    const newState = !emailNotifs;
                    setEmailNotifs(newState);
                    trackNotificationChannelToggled({ channel: "email", enabled: newState });
                    toast.success(newState ? "Email notifications enabled" : "Email notifications disabled");
                  }}
                >
                  {emailNotifs ? "Enabled" : "Disabled"}
                </Button>
              </div>

              <Separator />

              {/* Test email */}
              <div>
                <p className="text-sm font-medium mb-1">Verify your email</p>
                <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                  Send a test email to make sure notifications reach your inbox.
                  If it lands in spam, mark it as &ldquo;Not Spam&rdquo; and add <strong>alerts@pagealert.io</strong> to your contacts.
                </p>
                {testEmailSent ? (
                  <div className="flex items-center gap-2 text-sm text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" />
                    Test email sent to {email} — check your inbox
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    disabled={testEmailSending}
                    onClick={async () => {
                      setTestEmailSending(true);
                      try {
                        await sendTestEmail();
                        setTestEmailSent(true);
                        trackTestEmailSent();
                        toast.success("Test email sent", {
                          description: `Check ${email} for the verification email`,
                        });
                      } catch (e) {
                        toast.error("Failed to send test email", {
                          description: e instanceof Error ? e.message : "Please try again",
                        });
                      } finally {
                        setTestEmailSending(false);
                      }
                    }}
                  >
                    {testEmailSending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    Send Test Email
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <MessageCircle className="h-5 w-5 text-muted-foreground" />
                Telegram
              </CardTitle>
              <CardDescription className="text-sm">
                {tier === "free"
                  ? "Get instant Telegram notifications on one monitor"
                  : "Get instant notifications via Telegram bot"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="telegram" className="text-sm font-medium">Chat ID</Label>
                <Input
                  id="telegram"
                  placeholder="Your Telegram chat ID"
                  value={telegramChatId}
                  onChange={(e) => setTelegramChatId(e.target.value)}
                />
                <div className="text-xs text-muted-foreground leading-relaxed space-y-1">
                  <p className="font-medium text-foreground/70">How to get your Chat ID:</p>
                  <ol className="list-decimal pl-4 space-y-0.5">
                    <li>Open Telegram and message <a href="https://t.me/PageAlertNotify_bot" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-semibold">@PageAlertNotify_bot</a></li>
                    <li>Press <strong>Start</strong> — the bot will send your Chat ID as a separate message</li>
                    <li>Copy the number and paste it above, then click Connect &amp; Test</li>
                  </ol>
                  <Dialog open={telegramQrOpen} onOpenChange={setTelegramQrOpen}>
                    <button
                      onClick={() => setTelegramQrOpen(true)}
                      className="mt-2 text-primary hover:underline text-xs font-medium flex items-center gap-1"
                    >
                      <MessageCircle className="h-3 w-3" />
                      Open on phone? Scan QR code
                    </button>
                    <DialogContent className="sm:max-w-xs">
                      <DialogHeader>
                        <DialogTitle className="text-center">Scan to open in Telegram</DialogTitle>
                        <DialogDescription className="text-center text-xs">
                          Scan with your phone camera to message @PageAlertNotify_bot
                        </DialogDescription>
                      </DialogHeader>
                      <div className="flex justify-center py-4">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent("https://t.me/PageAlertNotify_bot")}&bgcolor=0a0a0b&color=3b82f6&format=svg`}
                          alt="QR code to open PageAlert bot in Telegram"
                          width={200}
                          height={200}
                          className="rounded-lg"
                        />
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              </div>
              {notifSettings?.find((s) => s.channel === "telegram")?.enabled ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">Connected</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={telegramTesting}
                    onClick={async () => {
                      setTelegramTesting(true);
                      try {
                        const chatId = notifSettings?.find((s) => s.channel === "telegram")?.target;
                        if (chatId) {
                          await sendTelegramTest({ chatId });
                          toast.success("Test message sent to Telegram");
                        }
                      } catch (e) {
                        toast.error("Test failed", { description: e instanceof Error ? e.message : "" });
                      } finally {
                        setTelegramTesting(false);
                      }
                    }}
                  >
                    {telegramTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                    Send Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await removeSetting({ channel: "telegram" });
                        setTelegramChatId("");
                        trackNotificationChannelToggled({ channel: "telegram", enabled: false });
                        toast.success("Telegram disconnected");
                      } catch {
                        toast.error("Failed to disconnect Telegram");
                      }
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!telegramChatId || telegramSaving}
                  onClick={async () => {
                    setTelegramSaving(true);
                    try {
                      await sendTelegramTest({ chatId: telegramChatId });
                      await upsertSetting({ channel: "telegram", enabled: true, target: telegramChatId });
                      trackNotificationChannelToggled({ channel: "telegram", enabled: true });

                      // Offer to enable on all existing monitors
                      if (monitors.length > 0) {
                        toast.success("Telegram connected!", {
                          description: `Enable Telegram notifications on all ${monitors.length} monitor${monitors.length !== 1 ? "s" : ""}?`,
                          action: {
                            label: "Enable all",
                            onClick: async () => {
                              try {
                                const updates = monitors
                                  .filter((m) => {
                                    const existing = (m as { notificationChannels?: NotificationChannel[] })
                                      .notificationChannels;
                                    return !existing || !existing.includes("telegram");
                                  })
                                  .map((m) => {
                                    const existing: NotificationChannel[] =
                                      (m as { notificationChannels?: NotificationChannel[] }).notificationChannels ??
                                      (["email"] as NotificationChannel[]);
                                    return updateMonitor({
                                      id: m._id,
                                      notificationChannels: [...existing, "telegram"],
                                    });
                                  });
                                await Promise.all(updates);
                                toast.success(`Telegram enabled on all monitors`);
                              } catch {
                                toast.error("Failed to update monitors");
                              }
                            },
                          },
                          duration: 10000,
                        });
                      } else {
                        toast.success("Telegram connected", { description: "Test message sent" });
                      }
                    } catch (e) {
                      toast.error("Failed to connect", {
                        description: e instanceof Error ? e.message : "Check your Chat ID and try again",
                      });
                    } finally {
                      setTelegramSaving(false);
                    }
                  }}
                >
                  {telegramSaving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  Connect & Test
                </Button>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5 opacity-60">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <Hash className="h-5 w-5 text-muted-foreground" />
                Discord
                <Badge variant="outline" className="text-[10px] gap-1 px-1.5 py-0 ml-1">
                  Coming soon
                </Badge>
              </CardTitle>
              <CardDescription className="text-sm">
                Send notifications to a Discord channel via webhook. Coming in a future update.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5 opacity-60">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <Hash className="h-5 w-5 text-muted-foreground" />
                Slack
                <Badge variant="outline" className="text-[10px] gap-1 px-1.5 py-0 ml-1">
                  Coming soon
                </Badge>
              </CardTitle>
              <CardDescription className="text-sm">
                Send notifications directly to a Slack channel. Coming in a future update.
              </CardDescription>
            </CardHeader>
          </Card>
        </TabsContent>

        <TabsContent value="billing" className="mt-8 space-y-8">
          {tierLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (<>
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
                  {tier === "free" && (
                    <Button
                      className="gap-1.5 shadow-md shadow-primary/15"
                      onClick={() => handleCheckout("pro")}
                    >
                      <Sparkles className="h-4 w-4" />
                      Upgrade to Pro
                    </Button>
                  )}
                  {tier === "pro" && (
                    <Button
                      className="gap-1.5 shadow-md shadow-primary/15"
                      onClick={() => handleCheckout("max")}
                    >
                      <Sparkles className="h-4 w-4" />
                      Upgrade to Max
                    </Button>
                  )}
                  {tier !== "free" && (
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
              {tier !== "free" && (
                <p className="text-xs text-muted-foreground mt-4">
                  Manage your billing, update payment method, or cancel your subscription from the Polar portal.
                  {" "}You&apos;ll be redirected to Polar — close the tab to return here.
                  {!isCancelled && " If you cancel, you'll keep access until the end of your billing period."}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Upgrade Options */}
          {tier === "free" && (
            <div className="grid gap-4 md:grid-cols-2">
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
          {tier === "pro" && (
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
