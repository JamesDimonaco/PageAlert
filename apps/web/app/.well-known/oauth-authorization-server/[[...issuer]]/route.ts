import { metadataCorsOptionsRequestHandler } from "mcp-handler";

/**
 * The sign-in server's metadata (RFC 8414). Better Auth runs on Convex and
 * serves this under /api/auth, but clients look for it at the site root.
 */
export async function GET(): Promise<Response> {
  const upstream = await fetch(
    `${process.env.NEXT_PUBLIC_CONVEX_SITE_URL}/api/auth/.well-known/oauth-authorization-server`,
    { cache: "no-store" }
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
