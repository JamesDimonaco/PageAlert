"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { User, Bell, CreditCard, Mail, MessageCircle, Hash, Trash2 } from "lucide-react";
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
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";

const FREE_MONITOR_LIMIT = 3;

export default function SettingsPage() {
  const { user, signOut } = useAuth();
  const { monitors } = useMonitors();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");

  const [emailNotifs, setEmailNotifs] = useState(true);
  const [telegramChatId, setTelegramChatId] = useState("");
  const [discordWebhook, setDiscordWebhook] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteAccountMutation = useMutation(api.account.deleteAccount);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
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
                    <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={async () => {
                        try {
                          await deleteAccountMutation();
                          toast.success("Account deleted");
                          await signOut();
                        } catch {
                          toast.error("Failed to delete account");
                        }
                      }}
                    >
                      Delete everything
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="mt-8 space-y-8">
          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <Mail className="h-5 w-5 text-muted-foreground" />
                Email
              </CardTitle>
              <CardDescription className="text-sm">Get notified at your account email</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{email}</p>
                  <p className="text-xs text-muted-foreground mt-1">Monitor match notifications</p>
                </div>
                <Button
                  variant={emailNotifs ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setEmailNotifs(!emailNotifs);
                    toast.success(emailNotifs ? "Email notifications disabled" : "Email notifications enabled");
                  }}
                >
                  {emailNotifs ? "Enabled" : "Disabled"}
                </Button>
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
                Get instant notifications via Telegram bot
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
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Message @ProwlBot on Telegram to get your chat ID
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => toast.success("Telegram connected")}
                disabled={!telegramChatId}
              >
                Connect
              </Button>
            </CardContent>
          </Card>

          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <Hash className="h-5 w-5 text-muted-foreground" />
                Discord
              </CardTitle>
              <CardDescription className="text-sm">
                Send notifications to a Discord channel via webhook
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
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => toast.success("Discord connected")}
                disabled={!discordWebhook}
              >
                Connect
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="billing" className="mt-8 space-y-8">
          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg font-semibold">Current Plan</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <p className="text-xl font-bold">Free</p>
                    <Badge variant="outline" className="text-xs">Current plan</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                    3 monitors, 6 hour check interval, email only
                  </p>
                </div>
                <Button className="shadow-md shadow-primary/15">Upgrade to Pro</Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg font-semibold">Usage</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="font-medium">Monitors</span>
                    <span className="text-muted-foreground tabular-nums">{monitors.length} / {FREE_MONITOR_LIMIT}</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${monitors.length > FREE_MONITOR_LIMIT ? "bg-amber-500" : "bg-primary"}`}
                      style={{ width: `${Math.min((monitors.length / FREE_MONITOR_LIMIT) * 100, 100)}%` }}
                    />
                  </div>
                  {monitors.length >= FREE_MONITOR_LIMIT && (
                    <p className="text-xs text-amber-400 mt-2 font-medium">
                      {monitors.length > FREE_MONITOR_LIMIT ? "Over limit - upgrade to add more" : "At limit - upgrade for more monitors"}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
