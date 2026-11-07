"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Bell, Mail, MessageCircle, Hash, Send, CheckCircle2, Loader2, ExternalLink, Smartphone, Lock } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { useMonitors } from "@/hooks/use-monitors";
import { useTier } from "@/hooks/use-tier";
import { usePush } from "@/hooks/use-push";
import { PushNotShownSteps, QrCode } from "@/components/prowl/push-help";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import { trackTestEmailSent, trackNotificationChannelToggled } from "@/lib/posthog";
import { errorText } from "@/lib/utils";

type NotificationChannel = "email" | "telegram" | "discord" | "push" | "sms";

/** Where the push test is: waiting on the send, asking the user, or showing a fix */
type PushTestStage = "idle" | "sending" | "asking" | "not-seen" | "lost";

/**
 * The Notifications tab. Two questions: where can PageAlert reach me, and
 * which emails do I want from it. Each channel is a row with its status; the
 * setup steps sit in a dialog behind Connect or Manage. Each monitor still
 * picks which ready channels it uses.
 */
export function NotificationSettings() {
  const { user } = useAuth();
  const email = user?.email ?? "";
  const push = usePush();
  const [pushTest, setPushTest] = useState<PushTestStage>("idle");
  const [showPhoneQr, setShowPhoneQr] = useState(false);
  const onMobile = push.device?.os === "ios" || push.device?.os === "android";

  const runPushTest = async () => {
    setPushTest("sending");
    try {
      setPushTest((await push.sendTest()) === "arrived" ? "asking" : "lost");
    } catch (e) {
      setPushTest("idle");
      toast.error("Test failed", {
        description: errorText(e, e instanceof Error ? e.message : "Try again"),
      });
    }
  };
  const { monitors } = useMonitors();
  const { tier } = useTier();

  const [open, setOpen] = useState<NotificationChannel | null>(null);
  const [telegramChatId, setTelegramChatId] = useState("");
  const [discordWebhook, setDiscordWebhook] = useState("");
  const [telegramQrOpen, setTelegramQrOpen] = useState(false);
  const [testEmailSending, setTestEmailSending] = useState(false);
  const [testEmailSent, setTestEmailSent] = useState(false);
  const [telegramSaving, setTelegramSaving] = useState(false);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [discordSaving, setDiscordSaving] = useState(false);
  // Texts are the one channel with a two-step connect: a number is not a
  // destination until a code sent to it comes back. "code" means one is in
  // flight. See convex/sms.ts.
  const [smsPhone, setSmsPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [smsStep, setSmsStep] = useState<"phone" | "code">("phone");
  // Unchecked by default and never persisted: consent is given at the
  // moment a number is submitted, not remembered from last time.
  const [smsConsent, setSmsConsent] = useState(false);
  const [smsSending, setSmsSending] = useState(false);
  const sendTestEmail = useAction(api.notifications.sendTestEmail);
  const upsertSetting = useMutation(api.notificationSettings.upsert);
  const removeSetting = useMutation(api.notificationSettings.remove);
  const sendTelegramTest = useAction(api.telegram.sendTestMessage);
  const sendDiscordTest = useAction(api.discord.sendTestMessage);
  const startSmsVerification = useAction(api.sms.startVerification);
  const confirmSmsVerification = useMutation(api.sms.confirmVerification);
  const smsAllowance = useQuery(api.tiers.smsAllowance);
  const smsEnabled = useQuery(api.sms.isEnabled);
  const updateMonitor = useMutation(api.monitors.update);
  const notifSettings = useQuery(api.notificationSettings.list);
  const optOuts = useQuery(api.unsubscribe.myOptOuts);
  const [savingOptOut, setSavingOptOut] = useState(false);
  const setOptOut = useMutation(api.unsubscribe.setMyOptOut);

  // "Set up texts" links here with #sms. The flag query resolves after mount,
  // so open the dialog once it does.
  const [hashChecked, setHashChecked] = useState(false);
  const openFromHash = () => {
    if (window.location.hash !== "#sms") return;
    setOpen("sms");
    // Otherwise every reload reopens it.
    history.replaceState(null, "", window.location.pathname + window.location.search);
  };
  if (smsEnabled !== undefined && !hashChecked) {
    setHashChecked(true);
    if (smsEnabled) openFromHash();
  }
  // A link to #sms followed while this tab is already open.
  useEffect(() => {
    if (!smsEnabled) return;
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  });

  // Sync settings from DB to local state on first load only
  const [settingsSynced, setSettingsSynced] = useState(false);
  if (notifSettings && !settingsSynced) {
    setSettingsSynced(true);
    const tg = notifSettings.find((s) => s.channel === "telegram");
    if (tg) setTelegramChatId(tg.target);
    const dc = notifSettings.find((s) => s.channel === "discord");
    if (dc) setDiscordWebhook(dc.target);
  }

  const connected = (channel: "sms" | "telegram" | "discord") =>
    notifSettings?.find((s) => s.channel === channel)?.enabled ?? false;
  const smsTarget = connected("sms") ? notifSettings?.find((s) => s.channel === "sms")?.target : undefined;

  const channels: Array<{
    id: NotificationChannel;
    icon: ReactNode;
    name: string;
    blurb: string;
    ready: boolean;
    /** Shown in place of the blurb when there is something to report. */
    status?: string;
  }> = [
    {
      id: "email",
      icon: <Mail className="h-5 w-5" />,
      name: "Email",
      blurb: "Match alerts and errors, to your account email",
      ready: true,
      status: email,
    },
    ...(smsEnabled
      ? [
          {
            id: "sms" as const,
            icon: <Smartphone className="h-5 w-5" />,
            name: "Text message",
            blurb: tier === "free" ? "A text when something changes. Paid plans only" : "A text when something changes",
            ready: connected("sms") && tier !== "free",
            status: tier === "free" ? undefined : smsTarget ? `••• ••• ${smsTarget.slice(-4)}` : undefined,
          },
        ]
      : []),
    {
      id: "telegram",
      icon: <MessageCircle className="h-5 w-5" />,
      name: "Telegram",
      blurb: tier === "free" ? "Instant messages from our bot, on one monitor" : "Instant messages from our bot",
      ready: connected("telegram"),
      status: connected("telegram") ? "Connected" : undefined,
    },
    {
      id: "push",
      icon: <Bell className="h-5 w-5" />,
      name: "Browser & phone alerts",
      blurb: "A notification on this device the moment a match lands",
      ready: push.state === "on",
      status:
        push.state === "on"
          ? push.deviceCount > 1
            ? `On here and ${push.deviceCount - 1} other device${push.deviceCount - 1 !== 1 ? "s" : ""}`
            : "On for this device"
          : push.deviceCount > 0
            ? `On for ${push.deviceCount} other device${push.deviceCount !== 1 ? "s" : ""}`
            : push.state === "loading"
              ? "Checking this device…"
              : undefined,
    },
    {
      id: "discord",
      icon: <Hash className="h-5 w-5" />,
      name: "Discord",
      blurb: tier === "free" ? "Posts to a Discord channel, on one monitor" : "Posts to a Discord channel",
      ready: connected("discord"),
      status: connected("discord") ? "Connected" : undefined,
    },
  ];
  const openChannel = channels.find((c) => c.id === open);

  const emailTypes: Array<{ id: "tips" | "updates"; name: string; blurb: string }> = [
    { id: "tips", name: "Tips", blurb: "Getting-started emails and ideas for monitors" },
    { id: "updates", name: "Product updates", blurb: "New features, now and then" },
  ];

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Where alerts go</h2>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
            Set each one up once. Then each monitor picks which of these it uses.
            {tier === "free" && " On free, one monitor can use Telegram or Discord. Upgrade for all of them, and for texts."}
          </p>
        </div>
        <div className="divide-y divide-border/30 rounded-xl border border-border/30 bg-card/50 shadow-sm shadow-black/5">
          {channels.map((c) => (
            <div key={c.id} className="flex items-center gap-4 p-4">
              <div className="text-muted-foreground shrink-0">{c.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium">{c.name}</p>
                  {c.ready ? (
                    <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">Ready</Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">{c.status ?? c.blurb}</p>
              </div>
              <Button
                variant={c.ready ? "ghost" : "outline"}
                size="sm"
                className="shrink-0"
                disabled={c.id === "push" && push.state === "loading"}
                onClick={() => setOpen(c.id)}
              >
                {c.ready ? "Manage" : "Connect"}
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-4 p-4">
            <div className="text-muted-foreground shrink-0">
              <Hash className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Slack</p>
              <p className="text-xs text-muted-foreground mt-0.5">Coming in a future update</p>
            </div>
            <Badge variant="outline" className="text-xs px-1.5 py-0">Coming soon</Badge>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Emails from us</h2>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
            These are separate from your alerts. Turning them off never stops an alert.
          </p>
        </div>
        <div className="divide-y divide-border/30 rounded-xl border border-border/30 bg-card/50 shadow-sm shadow-black/5">
          <div className="flex items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Essential</p>
              <p className="text-xs text-muted-foreground mt-0.5">Account, billing and security emails. These can&apos;t be turned off.</p>
            </div>
            <Lock className="h-4 w-4 text-muted-foreground shrink-0" aria-label="Always on" />
          </div>
          {emailTypes.map((t) => {
            const off = optOuts?.includes(t.id) ?? false;
            return (
              <div key={t.id} className="flex items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t.blurb}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={optOuts === undefined || savingOptOut}
                  onClick={async () => {
                    setSavingOptOut(true);
                    try {
                      await setOptOut({ category: t.id, optedOut: !off });
                      toast.success(off ? `${t.name} turned on` : `${t.name} turned off`);
                    } catch {
                      toast.error("Couldn't save that. Try again.");
                    } finally {
                      setSavingOptOut(false);
                    }
                  }}
                >
                  {/* The verb, not the state. See AnalyticsToggle. */}
                  {off ? "Turn on" : "Turn off"}
                </Button>
              </div>
            );
          })}
        </div>
      </section>

      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {openChannel?.icon}
              {openChannel?.name}
            </DialogTitle>
            <DialogDescription>{openChannel?.blurb}</DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
          {open === "email" && (
            <>
            <p className="text-sm break-all">Alerts go to <strong>{email}</strong>.</p>
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
                        description: errorText(e, e instanceof Error ? e.message : "Please try again"),
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
            </>
          )}
          {open === "sms" && (
            <>
            {tier === "free" ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Text alerts come with every paid plan, from the $4 Sprint pass up.
                  {connected("sms") && " Your saved number gets texts again as soon as you upgrade."}
                </p>
                <Link href="/dashboard/settings?tab=billing" onClick={() => setOpen(null)} className={buttonVariants({ size: "sm" })}>
                  See plans
                </Link>
              </div>
            ) : connected("sms") ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
                    ••• ••• {smsTarget?.slice(-4)}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await removeSetting({ channel: "sms" });
                        setSmsPhone("");
                        setSmsStep("phone");
                        setSmsConsent(false);
                        trackNotificationChannelToggled({ channel: "sms", enabled: false });
                        toast.success("Text alerts turned off");
                      } catch {
                        toast.error("Failed to turn off text alerts");
                      }
                    }}
                  >
                    Turn off
                  </Button>
                </div>
                {smsAllowance && (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {smsAllowance.monthRemaining} of {smsAllowance.monthLimit} texts left this month
                    {" · "}
                    {smsAllowance.dayRemaining} of {smsAllowance.dayLimit} left today.
                    {" "}
                    Once they run out, alerts keep arriving by email.
                  </p>
                )}
              </>
            ) : smsStep === "code" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="sms-code" className="text-sm font-medium">Enter the 6-digit code</Label>
                  <Input
                    id="sms-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    value={smsCode}
                    onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, ""))}
                  />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Sent to {smsPhone}. It expires in 10 minutes.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={smsCode.length !== 6 || smsSending}
                    onClick={async () => {
                      setSmsSending(true);
                      try {
                        await confirmSmsVerification({ code: smsCode });
                        setSmsCode("");
                        setSmsStep("phone");
                        trackNotificationChannelToggled({ channel: "sms", enabled: true });
                        toast.success("Text alerts on", { description: "Pick the monitors you want them for" });
                      } catch (e) {
                        toast.error("Could not confirm", {
                          description: errorText(e, e instanceof Error ? e.message : "Check the code and try again"),
                        });
                      } finally {
                        setSmsSending(false);
                      }
                    }}
                  >
                    {smsSending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                    Confirm
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSmsStep("phone");
                      setSmsCode("");
                    }}
                  >
                    Use a different number
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="sms-phone" className="text-sm font-medium">Mobile number</Label>
                  <Input
                    id="sms-phone"
                    type="tel"
                    autoComplete="tel"
                    placeholder="+44 7911 123456"
                    value={smsPhone}
                    onChange={(e) => setSmsPhone(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Start with your country code, not 0. UK, EU, US and Canada.
                  </p>
                </div>

                {/*
                  The consent tick. Carriers require a standalone, unchecked
                  action that names text messages, says what arrives and how
                  often, and warns about carrier charges — separate from
                  signing up and from accepting the terms. Our first toll-free
                  registration was rejected (Twilio 30513) because the screen
                  collected a number and said none of that. Changing the
                  wording here without updating /sms-policy, which quotes it
                  for reviewers, puts the two out of step.
                */}
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={smsConsent}
                    onChange={(e) => setSmsConsent(e.target.checked)}
                    className="rounded border-border accent-primary h-4 w-4 mt-0.5 shrink-0"
                  />
                  <span className="text-xs text-muted-foreground leading-relaxed">
                    I agree to receive <strong className="text-foreground">text messages</strong> from
                    PageAlert about the pages I monitor. How many depends on the monitors I choose,
                    up to my plan&apos;s limit. Message and data rates may apply. Reply STOP to a text
                    to stop them, or turn them off here any time. See the{" "}
                    <Link href="/terms" className="text-primary underline underline-offset-2">terms</Link> and{" "}
                    <Link href="/privacy" className="text-primary underline underline-offset-2">privacy policy</Link>.
                  </span>
                </label>

                <Button
                  variant="outline"
                  size="sm"
                  disabled={!smsConsent || smsPhone.trim().length < 8 || smsSending}
                  onClick={async () => {
                    setSmsSending(true);
                    try {
                      await startSmsVerification({ phone: smsPhone.trim() });
                      setSmsStep("code");
                      toast.success("Code sent", { description: "Check your messages" });
                    } catch (e) {
                      toast.error("Could not send a code", {
                        description: errorText(e, e instanceof Error ? e.message : "Check the number and try again"),
                      });
                    } finally {
                      setSmsSending(false);
                    }
                  }}
                >
                  {smsSending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  Send me a code
                </Button>
              </>
            )}
            </>
          )}
          {open === "telegram" && (
            <>
            {/* Action buttons — only shown until Telegram is connected.
                These were previously buried inside the helper text below
                the Chat ID input; promoting them so the user has an
                obvious "do this first" path. See PROWL-038 Phase 1d. */}
            {!notifSettings?.find((s) => s.channel === "telegram")?.enabled && (
              <div className="space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <a
                    href="https://t.me/PageAlertNotify_bot"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({
                      variant: "outline",
                      className: "h-auto flex-col items-start gap-1 py-3 px-4 text-left whitespace-normal",
                    })}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <ExternalLink className="h-4 w-4" />
                      Open in Telegram
                    </span>
                    <span className="text-xs text-muted-foreground font-normal">
                      If Telegram is on this device
                    </span>
                  </a>
                  <button
                    type="button"
                    onClick={() => setTelegramQrOpen(true)}
                    className={buttonVariants({
                      variant: "outline",
                      className: "h-auto flex-col items-start gap-1 py-3 px-4 text-left whitespace-normal",
                    })}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <Smartphone className="h-4 w-4" />
                      Scan QR code
                    </span>
                    <span className="text-xs text-muted-foreground font-normal">
                      Open on your phone instead
                    </span>
                  </button>
                </div>
                <p className="text-xs text-center text-muted-foreground">
                  Press <strong className="text-foreground/80">Start</strong> in the bot — it will reply with your Chat ID, then paste it below.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="telegram" className="text-sm font-medium">Chat ID</Label>
              <Input
                id="telegram"
                placeholder="Your Telegram chat ID"
                // Connected has no save, so an edit here would go nowhere. Disconnect to change it.
                readOnly={connected("telegram")}
                value={telegramChatId}
                onChange={(e) => setTelegramChatId(e.target.value)}
              />
            </div>

            {/* QR dialog — controlled by `telegramQrOpen` so the trigger
                button can live anywhere in the card. */}
            <Dialog open={telegramQrOpen} onOpenChange={setTelegramQrOpen}>
              <DialogContent className="sm:max-w-xs">
                <DialogHeader>
                  <DialogTitle className="text-center">Scan to open in Telegram</DialogTitle>
                  <DialogDescription className="text-center text-xs">
                    Scan with your phone camera to message @PageAlertNotify_bot
                  </DialogDescription>
                </DialogHeader>
                <div className="flex justify-center py-4">
                  <QrCode
                    value="https://t.me/PageAlertNotify_bot"
                    label="QR code to open PageAlert bot in Telegram"
                    className="h-[200px] w-[200px]"
                  />
                </div>
              </DialogContent>
            </Dialog>
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
                      if (!chatId) {
                        toast.error("No Telegram chat ID configured");
                        return;
                      }
                      await sendTelegramTest({ chatId });
                      toast.success("Test message sent to Telegram");
                    } catch (e) {
                      toast.error("Test failed", { description: errorText(e, e instanceof Error ? e.message : "") });
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
                                  // Skip undefined (already sends to all) and those already including telegram
                                  return existing !== undefined && !existing.includes("telegram");
                                })
                                .map((m) => {
                                  const existing = (m as { notificationChannels?: NotificationChannel[] })
                                    .notificationChannels!;
                                  return updateMonitor({
                                    id: m._id,
                                    notificationChannels: [...existing, "telegram"],
                                  });
                                });
                              await Promise.all(updates);
                              toast.success(`Telegram enabled on all monitors`);
                            } catch (err) {
                              toast.error("Failed to update monitors", { description: errorText(err, "Try again.") });
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
                      description: errorText(e, e instanceof Error ? e.message : "Check your Chat ID and try again"),
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
            </>
          )}
          {open === "push" && (
            <>
            {push.state === "loading" && (
              <p className="text-sm text-muted-foreground">Checking this device...</p>
            )}

            {push.state === "unsupported" && (
              <p className="text-sm text-muted-foreground leading-relaxed">
                This browser can&apos;t show alerts here. Chrome, Edge, Firefox and
                Safari all can — or keep using email, which works everywhere.
              </p>
            )}

            {push.state === "needs-install" && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  On iPhone and iPad, notifications only work once PageAlert is on your
                  home screen. It takes a moment:
                </p>
                <ol className="space-y-1.5 text-sm text-muted-foreground list-decimal list-inside">
                  <li>Tap the Share button at the bottom of Safari</li>
                  <li>Scroll down and tap <strong className="text-foreground">Add to Home Screen</strong></li>
                  <li>Open PageAlert from your home screen and come back here</li>
                </ol>
              </div>
            )}

            {push.state === "denied" && (
              <p className="text-sm text-muted-foreground leading-relaxed">
                Notifications are blocked for this site, so we can&apos;t ask again from
                here. Allow them in your browser&apos;s site settings, then reload.
              </p>
            )}

            {push.state === "off" && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Your browser will ask permission once. Enable it on every device you
                  want alerts on.
                </p>
                <Button
                  size="sm"
                  className="shrink-0"
                  disabled={push.busy}
                  onClick={async () => {
                    // A dead device drops to "off" mid-test, which can leave
                    // the lost panel waiting to reappear on re-enable
                    setPushTest("idle");
                    try {
                      await push.enable();
                      trackNotificationChannelToggled({ channel: "push", enabled: true });

                      // Existing monitors carry an explicit channel list, so
                      // turning push on here reaches none of them until they
                      // are updated. Same offer the Telegram card makes.
                      const needsPush = monitors.filter((m) => {
                        const existing = (m as { notificationChannels?: NotificationChannel[] })
                          .notificationChannels;
                        return existing !== undefined && !existing.includes("push");
                      });

                      if (needsPush.length > 0) {
                        toast.success("Alerts on", {
                          description: `Turn alerts on for your ${needsPush.length} existing monitor${needsPush.length !== 1 ? "s" : ""} too?`,
                          action: {
                            label: "Enable all",
                            onClick: async () => {
                              try {
                                await Promise.all(
                                  needsPush.map((m) => {
                                    const existing = (m as { notificationChannels?: NotificationChannel[] })
                                      .notificationChannels!;
                                    return updateMonitor({
                                      id: m._id,
                                      notificationChannels: [...existing, "push"],
                                    });
                                  })
                                );
                                toast.success("Alerts enabled on all monitors");
                              } catch (err) {
                                toast.error("Failed to update monitors", { description: errorText(err, "Try again.") });
                              }
                            },
                          },
                          duration: 10000,
                        });
                      } else {
                        toast.success("Alerts on", {
                          description: "Send a test to check it reaches you.",
                          action: {
                            label: "Send test",
                            onClick: () => void runPushTest(),
                          },
                          duration: 10000,
                        });
                      }
                    } catch (e) {
                      toast.error("Couldn't turn on alerts", {
                        description: errorText(e, e instanceof Error ? e.message : "Try again"),
                      });
                    }
                  }}
                >
                  {push.busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  Enable on this device
                </Button>
              </div>
            )}

            {push.state === "on" && (
              <>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                    <p className="text-sm">
                      On for this device
                      {push.deviceCount > 1 && (
                        <span className="text-muted-foreground">
                          {" "}and {push.deviceCount - 1} other
                          {push.deviceCount - 1 !== 1 ? "s" : ""}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pushTest === "sending"}
                      onClick={() => void runPushTest()}
                    >
                      {pushTest === "sending" ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-3.5 w-3.5 mr-1" />}
                      Send test
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={push.busy}
                      onClick={async () => {
                        try {
                          await push.disable();
                          setPushTest("idle");
                          trackNotificationChannelToggled({ channel: "push", enabled: false });
                          toast.success("Alerts turned off for this device");
                        } catch {
                          toast.error("Couldn't turn off alerts");
                        }
                      }}
                    >
                      Turn off
                    </Button>
                  </div>
                </div>

                {pushTest === "sending" && (
                  <p className="text-xs text-muted-foreground">
                    Waiting for the test to arrive. This can take up to 30 seconds.
                  </p>
                )}

                {pushTest === "asking" && (
                  <div className="rounded-lg border border-border/40 bg-muted/20 p-4 space-y-3">
                    <p className="text-sm">
                      The test reached this browser. Did a notification pop up?
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          setPushTest("idle");
                          toast.success("You're all set");
                        }}
                      >
                        Yes, I saw it
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setPushTest("not-seen")}>
                        No, nothing appeared
                      </Button>
                    </div>
                  </div>
                )}

                {pushTest === "not-seen" && push.device && (
                  <div className="rounded-lg border border-border/40 bg-muted/20 p-4 space-y-3">
                    <p className="text-sm leading-relaxed">
                      The alert got through, so your device is hiding it. Your system
                      settings can block notifications even when the browser allows them:
                    </p>
                    <PushNotShownSteps device={push.device} />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => void runPushTest()}>
                        Send another test
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPushTest("idle")}>
                        Close
                      </Button>
                    </div>
                  </div>
                )}

                {pushTest === "lost" && (
                  <div className="rounded-lg border border-border/40 bg-muted/20 p-4 space-y-3">
                    <p className="text-sm leading-relaxed">
                      The test hasn&apos;t reached this browser, so its connection has
                      probably gone stale. Click <strong>Turn off</strong>, then{" "}
                      <strong>Enable on this device</strong>, and send another test.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => void runPushTest()}>
                        Send another test
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPushTest("idle")}>
                        Close
                      </Button>
                    </div>
                  </div>
                )}

                <p className="text-xs text-muted-foreground leading-relaxed">
                  Turning it off here only affects this device. Your other devices keep
                  getting alerts.
                </p>
              </>
            )}

            {push.state !== "loading" && (
              <div className="space-y-3 border-t border-border/30 pt-4">
                {onMobile ? (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Want alerts on your computer too? Open pagealert.io there, sign in, go
                    to Settings → Notifications and click{" "}
                    <strong className="text-foreground">Enable on this device</strong>.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Each device is turned on separately. Get alerts on your phone
                        by scanning a code with its camera.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => setShowPhoneQr((v) => !v)}
                      >
                        <Smartphone className="h-3.5 w-3.5 mr-1" />
                        {showPhoneQr ? "Hide code" : "Set up your phone"}
                      </Button>
                    </div>
                    {showPhoneQr && (
                      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                        <QrCode
                          value={`${window.location.origin}/dashboard/settings?tab=notifications`}
                          label="QR code that opens PageAlert's notification settings"
                        />
                        <ol className="space-y-1.5 text-sm text-muted-foreground list-decimal list-inside">
                          <li>Point your phone&apos;s camera at the code and open the link</li>
                          <li>Sign in if it asks</li>
                          <li>
                            Tap <strong className="text-foreground">Enable on this device</strong>.
                            On iPhone, PageAlert shows you how to add it to your home screen
                            first
                          </li>
                        </ol>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            </>
          )}
          {open === "discord" && (
            <>
            {notifSettings?.find((s) => s.channel === "discord")?.enabled ? (
              <div className="flex items-center gap-2 flex-wrap">
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
              <>
                <div className="space-y-2">
                  <Label htmlFor="discord-webhook" className="text-sm font-medium">Webhook URL</Label>
                  <Input
                    id="discord-webhook"
                    placeholder="https://discord.com/api/webhooks/..."
                    value={discordWebhook}
                    onChange={(e) => setDiscordWebhook(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Discord → Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!discordWebhook.trim().startsWith("https://discord.com/api/webhooks/") || discordSaving}
                  onClick={async () => {
                    setDiscordSaving(true);
                    try {
                      const webhookUrl = discordWebhook.trim();
                      await sendDiscordTest({ webhookUrl });
                      await upsertSetting({ channel: "discord", enabled: true, target: webhookUrl });
                      trackNotificationChannelToggled({ channel: "discord", enabled: true });
                      toast.success("Discord connected", { description: "Test message sent" });
                    } catch (e) {
                      toast.error("Failed to connect", {
                        description: errorText(e, e instanceof Error ? e.message : "Check your webhook URL and try again"),
                      });
                    } finally {
                      setDiscordSaving(false);
                    }
                  }}
                >
                  {discordSaving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  Connect & Test
                </Button>
              </>
            )}
            </>
          )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
