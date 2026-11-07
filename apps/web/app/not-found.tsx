import { Radar } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="relative flex min-h-screen overflow-hidden items-center justify-center px-4">
      <div className="absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-primary/5 blur-3xl" />
      </div>

      <div className="text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/5 mx-auto mb-6">
          <Radar className="h-7 w-7 text-primary/60" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight mb-2">404</h1>
        <p className="text-muted-foreground mb-8">This page doesn&apos;t exist.</p>
        <Link href="/" className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          Back to PageAlert
        </Link>
      </div>
    </main>
  );
}
