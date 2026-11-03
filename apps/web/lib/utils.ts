import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { ConvexError } from "convex/values"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * The message to show for a failed Convex call. A ConvexError's data is what
 * the server said; its message on the client is a stack trace. Any other
 * server error reads "Server Error" in production, so the fallback stands in.
 */
export function errorText(err: unknown, fallback: string): string {
  return err instanceof ConvexError ? String(err.data) : fallback
}
