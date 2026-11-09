import type { ReactNode } from "react";

/** The one look for "nothing here": a card with a title, and a line or an action under it. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}
