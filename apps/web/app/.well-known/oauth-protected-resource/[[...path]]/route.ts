import { generateProtectedResourceMetadata, getPublicOrigin, metadataCorsOptionsRequestHandler } from "mcp-handler";

/**
 * Tells an AI app where to sign a user in for /api/mcp (RFC 9728). The resource
 * has to equal the URL the user pasted, and the issuer has to equal the one
 * Better Auth publishes, which is its base URL.
 */
export function GET(request: Request): Response {
  const origin = getPublicOrigin(request);
  return Response.json(
    generateProtectedResourceMetadata({
      resourceUrl: `${origin}/api/mcp`,
      authServerUrls: [`${origin}/api/auth`],
      additionalMetadata: { scopes_supported: ["offline_access"], bearer_methods_supported: ["header"] },
    }),
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=3600" } }
  );
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
