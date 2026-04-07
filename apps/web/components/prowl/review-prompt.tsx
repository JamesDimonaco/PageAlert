"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MessageSquare, Loader2, X } from "lucide-react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import { trackEvent } from "@/lib/posthog";

const MAX_QUOTE_LENGTH = 200;

export function ReviewPrompt() {
  const shouldPrompt = useQuery(api.reviews.shouldPrompt);
  const submitReview = useMutation(api.reviews.submit);
  const dismissReview = useMutation(api.reviews.dismiss);

  const [showForm, setShowForm] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("");
  const [quote, setQuote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Track prompt shown once
  const trackedRef = useRef(false);
  useEffect(() => {
    if (shouldPrompt && !trackedRef.current) {
      trackedRef.current = true;
      trackEvent("review_prompt_shown");
    }
  }, [shouldPrompt]);

  if (!shouldPrompt || dismissed) return null;

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await submitReview({
        displayName,
        role: role || undefined,
        quote,
      });
      toast.success("Thank you for your review!");
      trackEvent("review_submitted");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to submit review";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDismissPermanent() {
    try {
      await dismissReview();
    } catch {
      // Ignore errors — still dismiss locally
    }
    setDismissed(true);
  }

  if (showForm) {
    return (
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold">Write a quick review</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setShowForm(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Your name
              </label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="John Doe"
                maxLength={50}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                What do you do? (optional)
              </label>
              <Input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. Freelance Developer"
                maxLength={50}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                What do you think of PageAlert?
              </label>
              <Textarea
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
                placeholder="I love how easy it is to..."
                maxLength={MAX_QUOTE_LENGTH}
                rows={3}
              />
              <p className="text-xs text-muted-foreground text-right mt-1">
                {quote.length}/{MAX_QUOTE_LENGTH}
              </p>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button
                onClick={handleSubmit}
                disabled={submitting || !displayName.trim() || !quote.trim()}
                size="sm"
              >
                {submitting && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                Submit review
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowForm(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="p-4 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-start gap-3 flex-1">
            <MessageSquare className="h-5 w-5 text-primary mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold">
                Enjoying PageAlert? Share your experience!
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Your review helps others discover PageAlert.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-start sm:items-end gap-1.5">
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setShowForm(true)}>
                Write a quick review
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDismissed(true)}
              >
                Maybe later
              </Button>
            </div>
            <button
              onClick={handleDismissPermanent}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Not interested
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
