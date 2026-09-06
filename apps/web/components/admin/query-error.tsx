"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function QueryError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw className="h-3.5 w-3.5" /> Retry
      </Button>
    </div>
  );
}
