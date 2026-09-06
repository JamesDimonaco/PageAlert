"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Loader2, Send, FlaskConical, Users } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "./format";

export function AdminEmailComposer({
  selectedIds,
  onClearSelection,
  onPickRecipients,
}: {
  selectedIds: Set<string>;
  onClearSelection: () => void;
  onPickRecipients: () => void;
}) {
  const sendBulkEmail = useAction(api.admin.sendBulkEmail);
  const history = useQuery(api.admin.listSentEmails);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"test" | "send" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const count = selectedIds.size;
  const ready = subject.trim().length > 0 && body.trim().length > 0;

  async function send(testOnly: boolean) {
    if (!ready || busy) return;
    setBusy(testOnly ? "test" : "send");
    try {
      const result = await sendBulkEmail({ userIds: testOnly ? [] : [...selectedIds], subject, body, testOnly });
      if (testOnly) {
        toast.success("Test email sent to you");
      } else {
        toast.success(`Sent to ${result.sent} user${result.sent === 1 ? "" : "s"}${result.failed > 0 ? `, ${result.failed} failed` : ""}`);
        setSubject("");
        setBody("");
        setConfirming(false);
        onClearSelection();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5 lg:col-span-3">
        <CardHeader>
          <CardTitle className="text-lg">Compose</CardTitle>
          <CardDescription>
            Sent from hello@pagealert.io. Blank lines start a new paragraph. <code className="text-xs">{"{{name}}"}</code> becomes the recipient&apos;s first name.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border/30 bg-muted/20 px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              {count === 0 ? "No recipients selected" : `${count} recipient${count === 1 ? "" : "s"}`}
            </span>
            <Button size="sm" variant="ghost" onClick={onPickRecipients}>
              {count === 0 ? "Pick users" : "Change"}
            </Button>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="email-subject">Subject</Label>
            <Input id="email-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email-body">Body</Label>
            <Textarea
              id="email-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              maxLength={10_000}
              placeholder={"Hi {{name}},\n\nWe just shipped…"}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button variant="outline" disabled={!ready || busy !== null} onClick={() => send(true)}>
              {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
              Send test to me
            </Button>
            <div className="flex-1" />
            {confirming ? (
              <>
                <span className="text-sm text-muted-foreground">Send to {count}?</span>
                <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy !== null}>No</Button>
                <Button onClick={() => send(false)} disabled={busy !== null}>
                  {busy === "send" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Yes, send
                </Button>
              </>
            ) : (
              <Button disabled={!ready || count === 0 || busy !== null} onClick={() => setConfirming(true)}>
                <Send className="h-4 w-4" />
                Send to {count}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5 lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-lg">Sent</CardTitle>
          <CardDescription>Last 50 bulk sends.</CardDescription>
        </CardHeader>
        <CardContent>
          {!history ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
          ) : (
            <ul className="divide-y divide-border/30">
              {history.map((h) => (
                <li key={h._id} className="py-3">
                  <button
                    type="button"
                    className="text-left w-full"
                    onClick={() => { setSubject(h.subject); setBody(h.body); }}
                    title="Load into composer"
                  >
                    <p className="text-sm font-medium truncate">{h.subject}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDate(h.sentAt)} · {h.recipientCount} recipient{h.recipientCount === 1 ? "" : "s"}
                      {h.failedCount > 0 && <span className="text-red-400"> · {h.failedCount} failed</span>}
                    </p>
                    <p className="text-xs text-muted-foreground/70 truncate">{h.recipientsPreview.join(", ")}{h.recipientCount > 5 ? ", …" : ""}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
