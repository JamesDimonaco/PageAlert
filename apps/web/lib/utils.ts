import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { ConvexError } from "convex/values"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * The message to show for a failed Convex call. A ConvexError's message on
 * the client is a stack trace, and its data is what the server said.
 */
export function errorText(err: unknown, fallback = ""): string {
  if (err instanceof ConvexError) return String(err.data)
  return err instanceof Error ? err.message : fallback
}
