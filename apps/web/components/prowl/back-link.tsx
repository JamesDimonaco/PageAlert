import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export function BackLink({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className="mb-3 flex w-fit max-sm:-mt-3 max-sm:mb-0 max-sm:py-3 items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      <ArrowLeft className="h-4 w-4" />
      {children}
    </Link>
  );
}
