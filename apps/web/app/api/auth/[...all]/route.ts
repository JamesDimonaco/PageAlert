import { handler } from "@/lib/auth-server";

/**
 * The proxy to Convex is a fetch, and fetch stamps `sec-fetch-mode: cors` on
 * what it sends. The OAuth provider reads that as a script calling it, so it
 * answers a page navigation (an AI app sending the user to sign in, or the
 * return from Google) with `{ redirect, url }` JSON. This turns that answer
 * back into the redirect the browser needed.
 */
export async function GET(request: Request): Promise<Response> {
  const response = await handler.GET(request);
  if (
    request.headers.get("sec-fetch-mode") !== "navigate" ||
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return response;
  }
  const body: unknown = await response.clone().json().catch(() => null);
  if (typeof body !== "object" || body === null || !("redirect" in body) || !("url" in body)) return response;
  if (body.redirect !== true || typeof body.url !== "string") return response;

  // Keeps any Set-Cookie the sign-in wrote.
  const headers = new Headers(response.headers);
  for (const name of ["content-type", "content-length", "content-encoding"]) headers.delete(name);
  headers.set("location", body.url);
  return new Response(null, { status: 302, headers });
}

export const POST = handler.POST;
