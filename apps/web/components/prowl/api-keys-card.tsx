"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Copy, KeyRound, Loader2, Trash2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { timeAgo } from "@/lib/time";

const MCP_URL = "https://pagealert.io/api/mcp";

function addCommand(key: string): string {
  return `claude mcp add --transport http pagealert ${MCP_URL} --header "Authorization: Bearer ${key}"`;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Couldn't copy. Select it and copy by hand.");
  }
}

export function ApiKeysCard() {
  const keys = useQuery(api.apiKeys.listMine);
  const createKey = useMutation(api.apiKeys.create);
  const revokeKey = useMutation(api.apiKeys.revoke);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  async function handleCreate() {
    setCreating(true);
    try {
      const { key } = await createKey({ name: name.trim() || "My agent" });
      setNewKey(key);
      setName("");
    } catch (e) {
      toast.error("Couldn't create a key", { description: e instanceof Error ? e.message : "Try again" });
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: Id<"apiKeys">, keyName: string) {
    if (!confirm(`Revoke "${keyName}"? Any agent using it stops working straight away.`)) return;
    try {
      await revokeKey({ id });
      toast.success("Key revoked");
    } catch (e) {
      toast.error("Couldn't revoke the key", { description: e instanceof Error ? e.message : "Try again" });
    }
  }

  return (
    <Card className="border-border/30 bg-card/50 shadow-sm shadow-black/5">
      <CardHeader className="pb-4">
        <CardTitle className="text-lg font-semibold">API keys</CardTitle>
        <CardDescription className="text-sm">
          Let an AI agent such as Claude create monitors and read matches for you, over MCP. A key can do anything
          you can do with monitors, so treat it like a password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {newKey ? (
          <div className="space-y-3 rounded-lg border border-amber-400/40 bg-amber-400/5 p-4">
            <p className="text-sm font-medium">Copy this key now. You won&apos;t see it again.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">{newKey}</code>
              <Button variant="outline" size="sm" onClick={() => copy(newKey, "Key")}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">To add it to Claude Code, run:</p>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
                {addCommand(newKey)}
              </code>
              <Button variant="outline" size="sm" onClick={() => copy(addCommand(newKey), "Command")}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setNewKey(null)}>
              Done
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor="api-key-name">Name</Label>
              <Input
                id="api-key-name"
                placeholder="e.g. Claude Code on my laptop"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
              Generate key
            </Button>
          </div>
        )}

        {keys && keys.length > 0 && (
          <ul className="divide-y divide-border/40 rounded-lg border border-border/40">
            {keys.map((key) => (
              <li key={key._id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{key.name}</p>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono">{key.hint}…</span> · created {timeAgo(key.createdAt).toLowerCase()} ·{" "}
                    {key.lastUsedAt ? `last used ${timeAgo(key.lastUsedAt).toLowerCase()}` : "never used"}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleRevoke(key._id, key.name)}>
                  <Trash2 className="h-4 w-4" />
                  <span className="sr-only">Revoke {key.name}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
