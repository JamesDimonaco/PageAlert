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

const json = (value: unknown) => JSON.stringify(value, null, 2);

// Claude Desktop only runs local servers from its config file, so it reaches
// the remote endpoint through mcp-remote. The key rides in an env var because
// a space inside an args entry breaks on some platforms.
const SETUPS = [
  {
    id: "claude-code",
    label: "Claude Code",
    where: "Run this in your terminal:",
    text: (key: string) =>
      `claude mcp add --transport http pagealert ${MCP_URL} --header "Authorization: Bearer ${key}"`,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    where: "Add this to claude_desktop_config.json (Settings → Developer → Edit Config), then restart Claude:",
    text: (key: string) =>
      json({
        mcpServers: {
          pagealert: {
            command: "npx",
            args: ["mcp-remote", MCP_URL, "--header", "Authorization:${AUTH_HEADER}"],
            env: { AUTH_HEADER: `Bearer ${key}` },
          },
        },
      }),
  },
  {
    id: "cursor",
    label: "Cursor",
    where: "Add this to ~/.cursor/mcp.json:",
    text: (key: string) =>
      json({ mcpServers: { pagealert: { url: MCP_URL, headers: { Authorization: `Bearer ${key}` } } } }),
  },
] as const;

type SetupId = (typeof SETUPS)[number]["id"];

// These apps take no key. The user pastes the URL and signs in to PageAlert.
const APPS = [
  {
    id: "claude",
    label: "Claude",
    steps: [
      "Open Customize → Connectors.",
      "Select Add, then Add custom connector.",
      "Name it PageAlert, paste the URL, and add it.",
      "Select Connect, then sign in to PageAlert and approve.",
    ],
    note: "Works in Claude on the web, desktop and phone. On a Team or Enterprise plan, an Owner adds it first.",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    steps: [
      "Open chatgpt.com/plugins.",
      "Select the plus button, then Add custom MCP server.",
      "Name it PageAlert and paste the URL.",
      "Continue past the warning, then sign in to PageAlert and approve.",
    ],
    note: "Which plans can add a custom server is up to OpenAI, and it changes.",
  },
] as const;

type AppId = (typeof APPS)[number]["id"];

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
  const [setupId, setSetupId] = useState<SetupId>("claude-code");
  const setup = SETUPS.find((s) => s.id === setupId) ?? SETUPS[0];
  const apps = useQuery(api.connectedApps.listMine);
  const disconnectApp = useMutation(api.connectedApps.disconnect);
  const [appId, setAppId] = useState<AppId>("claude");
  const app = APPS.find((a) => a.id === appId) ?? APPS[0];

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

  async function handleDisconnect(clientId: string, appName: string) {
    if (!confirm(`Disconnect ${appName}? It stops working straight away.`)) return;
    try {
      await disconnectApp({ clientId });
      toast.success(`${appName} disconnected`);
    } catch (e) {
      toast.error("Couldn't disconnect it", { description: e instanceof Error ? e.message : "Try again" });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Connect your AI</CardTitle>
        <CardDescription className="text-sm">
          Let Claude, ChatGPT or Cursor set up monitors and read your matches for you. Ask it something like
          &quot;tell me when this GPU drops under $400&quot;. It connects over MCP, the standard way AI tools talk to
          apps.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Claude and ChatGPT apps</h3>
          <p className="text-sm text-muted-foreground">No key needed. Add PageAlert with this URL, then sign in.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">{MCP_URL}</code>
            <Button variant="outline" size="sm" onClick={() => copy(MCP_URL, "URL")}>
              <Copy className="h-4 w-4" />
              <span className="sr-only">Copy the URL</span>
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {APPS.map((a) => (
              <Button
                key={a.id}
                variant={a.id === appId ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={a.id === appId}
                onClick={() => setAppId(a.id)}
              >
                {a.label}
              </Button>
            ))}
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            {app.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">{app.note}</p>
          {apps && apps.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {apps.map((connected) => (
                <li key={connected.clientId} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{connected.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {connected.connectedAt
                        ? `Connected ${timeAgo(connected.connectedAt).toLowerCase()}`
                        : "Connected"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDisconnect(connected.clientId, connected.name)}
                  >
                    <Trash2 className="h-4 w-4" />
                    <span className="sr-only">Disconnect {connected.name}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Claude Code, Cursor and other tools</h3>
          <p className="text-sm text-muted-foreground">
            Generate a key, then paste it into your tool. Anyone with a key can act as you, so treat it like a
            password.
          </p>
          {newKey ? (
            <div className="space-y-3 rounded-lg border border-amber-400/40 bg-amber-400/5 p-4">
              <p className="text-sm font-medium">Copy this key now. You won&apos;t see it again.</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">{newKey}</code>
                <Button variant="outline" size="sm" onClick={() => copy(newKey, "Key")}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {SETUPS.map((s) => (
                  <Button
                    key={s.id}
                    variant={s.id === setupId ? "secondary" : "ghost"}
                    size="sm"
                    aria-pressed={s.id === setupId}
                    onClick={() => setSetupId(s.id)}
                  >
                    {s.label}
                  </Button>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">{setup.where}</p>
              <div className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
                  {setup.text(newKey)}
                </pre>
                <Button variant="outline" size="sm" onClick={() => copy(setup.text(newKey), "Setup")}>
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
                  placeholder="e.g. Claude on my laptop"
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
            <ul className="divide-y divide-border rounded-lg border border-border">
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
        </section>
      </CardContent>
    </Card>
  );
}
