import { buildLlmsTxt } from "@/lib/llms";

// Built once at build time; the inputs only change with a deploy.
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(buildLlmsTxt(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
