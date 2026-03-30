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

export default function SettingsPage() {
  const { user, signOut } = useAuth();
  const { monitors } = useMonitors();
  const { tier, maxMonitors, description: tierDescription, isLoading: tierLoading, refetch: refetchTier } = useTier();
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

  async function handleCheckout(slug: "pro" | "max") {
    trackUpgradePromptClicked({ plan: slug, currentTier: tier });
    try {
      await authClient.checkout({ slug });
    } catch {
      toast.error("Checkout unavailable", { description: "Billing is not configured yet" });
    }
  }

  const [emailNotifs, setEmailNotifs] = useState(true);
  const [telegramChatId, setTelegramChatId] = useState("");
  const [discordWebhook, setDiscordWebhook] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [testEmailSending, setTestEmailSending] = useState(false);
  const [testEmailSent, setTestEmailSent] = useState(false);
  const [telegramSaving, setTelegramSaving] = useState(false);
  const [discordSaving, setDiscordSaving] = useState(false);
  const deleteAccountMutation = useMutation(api.account.deleteAccount);
  const sendTestEmail = useAction(api.notifications.sendTestEmail);
  const upsertSetting = useMutation(api.notificationSettings.upsert);
  const removeSetting = useMutation(api.notificationSettings.remove);
  const sendTelegramTest = useAction(api.telegram.sendTestMessage);
  const sendDiscordTest = useAction(api.discord.sendTestMessage);
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
          <TabsTrigger value="notifications">
            <Bell className="mr-2 h-4 w-4" />
            Notifications
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
              Notifications are sent for <strong className="text-foreground">all your monitors</strong> when new matches are found or errors occur.
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

          <Card className={`border-border/30 bg-card/50 shadow-sm shadow-black/5 ${tier === "free" ? "opacity-60" : ""}`}>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <MessageCircle className="h-5 w-5 text-muted-foreground" />
                Telegram
                {tier === "free" && (
                  <Badge variant="outline" className="text-[10px] gap-1 px-1.5 py-0 ml-1">
                    <Lock className="h-2.5 w-2.5" />
                    Pro
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-sm">
                {tier === "free"
                  ? "Upgrade to Pro to get instant Telegram notifications"
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
                  disabled={tier === "free"}
                />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Message @PageAlertBot on Telegram to get your chat ID
                </p>
              </div>
              {tier === "free" ? (
                <Button size="sm" className="gap-1.5" onClick={() => handleCheckout("pro")}>
                  <Sparkles className="h-3.5 w-3.5" />
                  Upgrade to Pro
                </Button>
              ) : notifSettings?.find((s) => s.channel === "telegram")?.enabled ? (
                <div className="flex items-center gap-2">
                  <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">Connected</Badge>
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
                      toast.success("Telegram connected", { description: "Test message sent" });
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

          <Card className={`border-border/30 bg-card/50 shadow-sm shadow-black/5 ${tier === "free" ? "opacity-60" : ""}`}>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <Hash className="h-5 w-5 text-muted-foreground" />
                Discord
                {tier === "free" && (
                  <Badge variant="outline" className="text-[10px] gap-1 px-1.5 py-0 ml-1">
                    <Lock className="h-2.5 w-2.5" />
                    Pro
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-sm">
                {tier === "free"
                  ? "Upgrade to Pro to send notifications to Discord"
                  : "Send notifications to a Discord channel via webhook"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="discord" className="text-sm font-medium">Webhook URL</Label>
                <Input
                  id="discord"
                  type="url"
                  placeholder="https://discord.com/api/webhooks/..."
                  value={discordWebhook}
                  onChange={(e) => setDiscordWebhook(e.target.value)}
                  disabled={tier === "free"}
                />
              </div>
              {tier === "free" ? (
                <Button size="sm" className="gap-1.5" onClick={() => handleCheckout("pro")}>
                  <Sparkles className="h-3.5 w-3.5" />
                  Upgrade to Pro
                </Button>
              ) : notifSettings?.find((s) => s.channel === "discord")?.enabled ? (
                <div className="flex items-center gap-2">
                  <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">Connected</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await removeSetting({ channel: "discord" });
                        setDiscordWebhook("");
                        trackNotificationChannelToggled({ channel: "discord", enabled: false });
                        toast.success("Discord disconnected");
                      } catch {
                        toast.error("Failed to disconnect Discord");
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
                  disabled={!discordWebhook || discordSaving}
                  onClick={async () => {
                    setDiscordSaving(true);
                    try {
                      await sendDiscordTest({ webhookUrl: discordWebhook });
                      await upsertSetting({ channel: "discord", enabled: true, target: discordWebhook });
                      trackNotificationChannelToggled({ channel: "discord", enabled: true });
                      toast.success("Discord connected", { description: "Test message sent" });
                    } catch (e) {
                      toast.error("Failed to connect", {
                        description: e instanceof Error ? e.message : "Check your webhook URL and try again",
                      });
                    } finally {
                      setDiscordSaving(false);
                    }
                  }}
                >
                  {discordSaving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  Connect & Test
                </Button>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="billing" className="mt-8 space-y-8">
          {tierLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (<>
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
                    <Badge variant="outline" className="text-xs">Current plan</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                    {tierDescription}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {tier === "free" && (
                    <Button
                      className="gap-1.5 shadow-md shadow-primary/15 w-full sm:w-auto"
                      onClick={() => handleCheckout("pro")}
                    >
                      <Sparkles className="h-4 w-4" />
                      Upgrade to Pro
                    </Button>
                  )}
                  {tier !== "free" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 w-full sm:w-auto"
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
                    <li>API access + webhooks</li>
                  </ul>
                  <Button
                    variant="outline"
                    className="w-full mt-4 gap-1.5"
                    onClick={async () => {
                      handleCheckout("max");
                    }}
                  >
                    Upgrade to Max
                  </Button>
                </CardContent>
              </Card>
            </div>
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
