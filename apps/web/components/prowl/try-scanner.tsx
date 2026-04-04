"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Loader2, Radar, Sparkles, ArrowRight, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

const EXAMPLES = [
  {
    label: "Price drops",
    emoji: "💰",
    name: "MacBook Pro deals",
    url: "https://www.apple.com/shop/refurbished/mac/macbook-pro",
    prompt: "MacBook Pro under $1500",
  },
  {
    label: "Restock alerts",
    emoji: "🎮",
    name: "PS5 stock check",
    url: "https://www.amazon.com/s?k=playstation+5+console",
    prompt: "PlayStation 5 console in stock under $500",
  },
  {
    label: "Job hunting",
    emoji: "💼",
    name: "Remote React jobs",
    url: "https://uk.indeed.com/jobs?q=react+developer&l=Remote",
    prompt: "Senior React developer remote position",
  },
  {
    label: "Property search",
    emoji: "🏡",
    name: "Houses in Bristol",
    url: "https://www.rightmove.co.uk/house-prices/Bristol.html",
    prompt: "3 bedroom house under £400,000",
  },
  {
    label: "Deal hunting",
    emoji: "🔥",
    name: "Tech deals",
    url: "https://www.hotukdeals.com/search?q=laptop",
    prompt: "Laptop deal with at least 100 degrees hot",
  },
];

export function TryScanner() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [scanning, setScanning] = useState(false);
  const [selectedExample, setSelectedExample] = useState<number | null>(null);

  const createAnonymous = useMutation(api.anonymous.createAnonymous);
  const saveResult = useMutation(api.anonymous.saveAnonymousResult);
  const saveError = useMutation(api.anonymous.saveAnonymousError);
  const canScanQuery = useQuery(api.anonymous.canScan);

  const canScan = canScanQuery?.canScan ?? true;

  function selectExample(index: number) {
    const ex = EXAMPLES[index]!;
    setUrl(ex.url);
    setPrompt(ex.prompt);
    setSelectedExample(index);
  }

  async function handleScan() {
    if (!url || !prompt || scanning) return;

    // Check if user already has an anonymous monitor
    const existing = typeof window !== "undefined"
      ? localStorage.getItem("pagealert_anon_monitor")
      : null;
    if (existing) {
      try {
        const data = JSON.parse(existing);
        if (data.monitorId) {
          toast("You already have a free scan running", {
            action: {
              label: "View results",
              onClick: () => router.push(`/try/${data.monitorId}`),
            },
            duration: 8000,
          });
          return;
        }
      } catch {}
    }

    setScanning(true);

    try {
      // Determine name from URL
      let name: string;
      try {
        name = new URL(url).hostname.replace("www.", "");
      } catch {
        name = "Monitor";
      }
      if (selectedExample !== null) {
        name = EXAMPLES[selectedExample]!.name;
      }

      // Create the monitor in Convex
      const { monitorId, anonId } = await createAnonymous({ name, url, prompt });

      // Save to localStorage
      localStorage.setItem("pagealert_anon_monitor", JSON.stringify({
        monitorId,
        anonId,
        createdAt: Date.now(),
      }));

      // Call the anonymous scan API
      const res = await fetch("/api/anonymous/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, prompt, name }),
      });

      const json = await res.json();

      if (!res.ok) {
        await saveError({ monitorId, anonId, error: json.error || "Scan failed" });
        toast.error("Scan failed", { description: json.error });
        setScanning(false);
        return;
      }

      // Save results
      const matchCount = Array.isArray(json.matches) ? json.matches.length : 0;
      await saveResult({
        monitorId,
        anonId,
        schema: json.schema,
        matchCount,
      });

      // Navigate to results page
      router.push(`/try/${monitorId}`);
    } catch (e) {
      toast.error("Something went wrong", {
        description: e instanceof Error ? e.message : "Please try again",
      });
      setScanning(false);
    }
  }

  return (
    <div className="mx-auto mt-16 sm:mt-24 max-w-4xl">
      <div className="rounded-xl border-t-2 border-t-primary/40 border border-border/30 bg-card/60 p-4 sm:p-8 shadow-xl shadow-black/10 backdrop-blur">
        {/* Window chrome */}
        <div className="flex items-center gap-2 mb-6">
          <div className="h-3 w-3 rounded-full bg-red-500/50" />
          <div className="h-3 w-3 rounded-full bg-yellow-500/50" />
          <div className="h-3 w-3 rounded-full bg-green-500/50" />
          <span className="text-xs text-muted-foreground ml-2">Try it — no account needed</span>
        </div>

        {/* Example chips */}
        <div className="mb-5">
          <p className="text-xs font-medium text-muted-foreground mb-2">Quick examples — click to try:</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex, i) => (
              <button
                key={i}
                onClick={() => selectExample(i)}
                disabled={scanning}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                  selectedExample === i
                    ? "border-primary/40 bg-primary/10 text-primary scale-[1.02]"
                    : "border-border/40 bg-background/50 text-muted-foreground hover:border-primary/30 hover:bg-primary/5"
                }`}
              >
                <span>{ex.emoji}</span>
                {ex.label}
              </button>
            ))}
          </div>
        </div>

        {/* Form */}
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">URL to monitor</label>
            <Input
              type="url"
              placeholder="https://example.com/products"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setSelectedExample(null); }}
              disabled={scanning}
              className="bg-background/80"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">What are you looking for?</label>
            <Textarea
              placeholder='e.g. "MacBook Pro under $1500" or "3 bed house in Bristol"'
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setSelectedExample(null); }}
              disabled={scanning}
              rows={2}
              className="bg-background/80 resize-none"
            />
          </div>

          {!canScan && (
            <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 p-3">
              <p className="text-xs text-amber-400">
                We&apos;ve hit the daily limit for free scans.{" "}
                <a href="/login" className="underline font-medium">Create a free account</a> to scan right now.
              </p>
            </div>
          )}

          <Button
            onClick={handleScan}
            disabled={!url || !prompt || scanning || !canScan}
            className="w-full gap-2 h-11 text-sm font-semibold shadow-md shadow-primary/20"
          >
            {scanning ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                AI is scanning the page...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Try it free — no account needed
              </>
            )}
          </Button>
        </div>

        {scanning && (
          <div className="mt-4 flex items-center gap-2 pt-2 border-t border-border/20">
            <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
            <p className="text-xs text-muted-foreground">
              Scanning with AI... this usually takes 10-30 seconds
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
