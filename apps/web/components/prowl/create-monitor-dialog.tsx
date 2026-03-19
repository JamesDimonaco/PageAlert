"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Radar, Loader2 } from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";

interface CreateMonitorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: {
    name: string;
    url: string;
    prompt: string;
    checkInterval: Doc<"monitors">["checkInterval"];
  }) => void;
  editMonitor?: Doc<"monitors"> | null;
}

export function CreateMonitorDialog({
  open,
  onOpenChange,
  onSubmit,
  editMonitor,
}: CreateMonitorDialogProps) {
  const [name, setName] = useState(editMonitor?.name ?? "");
  const [url, setUrl] = useState(editMonitor?.url ?? "");
  const [prompt, setPrompt] = useState(editMonitor?.prompt ?? "");
  const [checkInterval, setCheckInterval] = useState<Doc<"monitors">["checkInterval"]>(
    editMonitor?.checkInterval ?? "1h"
  );
  const [loading, setLoading] = useState(false);

  const isEdit = !!editMonitor;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    // Simulate AI processing delay
    setTimeout(() => {
      onSubmit({ name, url, prompt, checkInterval });
      setLoading(false);
      resetForm();
      onOpenChange(false);
    }, 800);
  }

  function resetForm() {
    if (!editMonitor) {
      setName("");
      setUrl("");
      setPrompt("");
      setCheckInterval("1h");
    }
  }

  // Reset form when dialog opens with edit data
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen && editMonitor) {
      setName(editMonitor.name);
      setUrl(editMonitor.url);
      setPrompt(editMonitor.prompt);
      setCheckInterval(editMonitor.checkInterval);
    } else if (!newOpen) {
      resetForm();
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Radar className="h-4 w-4 text-primary" />
            </div>
            {isEdit ? "Edit Monitor" : "New Monitor"}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {isEdit
              ? "Update the monitor configuration."
              : "Paste a URL and describe what you're looking for. AI will handle the rest."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6 pt-2">
          <div className="space-y-2">
            <Label htmlFor="name" className="text-sm font-medium">Name</Label>
            <Input
              id="name"
              placeholder="e.g. MacBook Pro Refurbished"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="url" className="text-sm font-medium">URL to monitor</Label>
            <Input
              id="url"
              type="url"
              placeholder="https://apple.com/shop/refurbished/mac"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="prompt" className="text-sm font-medium">What are you looking for?</Label>
            <Textarea
              id="prompt"
              placeholder="e.g. MacBook Pro 14 inch M3 gray under $1500"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              required
            />
            <p className="text-xs text-muted-foreground leading-relaxed">
              Describe in plain English. Be as specific as you want.
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Check frequency</Label>
            <Select value={checkInterval} onValueChange={(v) => setCheckInterval(v as Doc<"monitors">["checkInterval"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5m">Every 5 minutes</SelectItem>
                <SelectItem value="15m">Every 15 minutes</SelectItem>
                <SelectItem value="30m">Every 30 minutes</SelectItem>
                <SelectItem value="1h">Every hour</SelectItem>
                <SelectItem value="6h">Every 6 hours</SelectItem>
                <SelectItem value="24h">Every 24 hours</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading} className="shadow-sm shadow-primary/15">
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEdit ? "Save Changes" : "Create Monitor"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
