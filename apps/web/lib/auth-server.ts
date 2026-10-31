import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";

export const {
  handler,
  isAuthenticated,
  getToken,
} = convexBetterAuthNextJs({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  convexSiteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL!,
});

/** The signed-in user's id (the JWT subject), or null. Not a replacement for isAuthenticated. */
export async function getUserId(): Promise<string | null> {
  const token = await getToken();
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const { sub } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub?: unknown };
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}
