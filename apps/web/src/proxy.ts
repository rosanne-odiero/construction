import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, createNonce, securityHeaders } from "./lib/security-headers";

/**
 * Security headers for every page and static file (ARCHITECTURE §4.17, D-150). Each request gets
 * a fresh nonce: Next.js reads it from the request's Content-Security-Policy and adds it to its own
 * scripts; the root layout passes it (x-nonce) to next-themes' inline script. /api is excluded: it
 * is rewritten to the API, which sends its own headers.
 */
export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const policy = contentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === "development",
    upgradeInsecureRequests:
      process.env.NODE_ENV === "production" &&
      (request.nextUrl.protocol === "https:" ||
        request.headers.get("x-forwarded-proto") === "https"),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  for (const [name, value] of securityHeaders(process.env.NODE_ENV === "production"))
    response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: ["/((?!api/).*)"],
};
