import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Radar } from "lucide-react";
import { CHANGELOG } from "@prowl/shared";

export const metadata: Metadata = {
  title: "Changelog",
  description: "What's new in PageAlert: new alert channels, features and fixes, newest first.",
  alternates: { canonical: "https://pagealert.io/changelog" },
};

function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function ChangelogPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/30 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-3xl items-center px-6">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Radar className="h-5 w-5 text-primary" />
            </div>
            <span className="text-xl font-bold tracking-tight">PageAlert</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Changelog</h1>
        <p className="text-sm text-muted-foreground mb-12">What&apos;s new in PageAlert, newest first.</p>

        <ol className="relative border-l border-border/40">
          {CHANGELOG.map((entry) => (
            <li key={entry.id} id={entry.id} className="mb-12 ml-6 scroll-mt-24 last:mb-0">
              <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
              <time dateTime={entry.date} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {formatDay(entry.date)}
              </time>
              <h2 className="mt-2 text-lg font-semibold text-foreground">{entry.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{entry.body}</p>
              {entry.cta && (
                <Link
                  href={entry.cta.href}
                  className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  {entry.cta.label}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              )}
            </li>
          ))}
        </ol>
      </main>
    </div>
  );
}
