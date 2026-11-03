import { NextResponse } from "next/server";

/**
 * The visitor's country as Vercel sees it, for prefilling the Find a product
 * region. Only the server can read this header; null off Vercel.
 */
export function GET(request: Request) {
  return NextResponse.json(
    { country: request.headers.get("x-vercel-ip-country") },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
