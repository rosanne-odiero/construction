import { TILE_ORIGIN } from "../components/maps/tiles";

/**
 * Browser security headers for every page and static file (ARCHITECTURE §18 and §4.17, D-150).
 * The nonce-based Content-Security-Policy is built per request in src/proxy.ts; API responses
 * (rewritten to /api) carry the API's own helmet headers instead.
 */

export type CspOptions = {
  /** Fresh per request (base64). Next.js finds it in the request's CSP and adds it to its scripts. */
  nonce: string;
  /** `next dev`: React needs eval for its debugging features, and the map tiles are allowed. */
  development: boolean;
  /** Only when the page was served over HTTPS; over plain HTTP it would break every asset. */
  upgradeInsecureRequests: boolean;
};

const NONCE = /^[A-Za-z0-9+/]{22,}={0,2}$/;

/**
 * Strict CSP (ASVS 5.0.0 V3.4.3, V3.4.6): scripts only with this response's nonce (and what those
 * scripts load, 'strict-dynamic'), no plugins, no <base>, no framing, forms and network calls to
 * this origin only. 'self' in script-src is ignored by browsers that understand 'strict-dynamic'
 * and only helps older ones.
 *
 * style-src keeps 'unsafe-inline' on purpose: React renders style attributes (Radix popovers,
 * progress bars, Recharts) and libraries insert <style> elements without a nonce (Sonner toasts,
 * the shadcn chart colours, react-remove-scroll). Injected CSS cannot run script; script-src is
 * the XSS control.
 */
export function contentSecurityPolicy({
  nonce,
  development,
  upgradeInsecureRequests,
}: CspOptions): string {
  if (!NONCE.test(nonce)) throw new Error("A CSP nonce must be base64 with at least 128 bits");
  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(development ? ["'unsafe-eval'"] : []),
    ],
    ["style-src", "'self'", "'unsafe-inline'"],
    // Photos, receipts and documents stream through same-origin /api routes; blob: is the camera
    // screen's preview of the photo just taken (D6.1), made by this page's own script.
    // OpenStreetMap tiles are a development-only aid (D-10).
    ["img-src", "'self'", "blob:", ...(development ? [TILE_ORIGIN] : [])],
    ["font-src", "'self'"],
    // Uploads and downloads go through the API (multipart, never pre-signed storage URLs).
    ["connect-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
    ["frame-src", "'none'"],
  ];
  if (upgradeInsecureRequests) directives.push(["upgrade-insecure-requests"]);
  return directives.map((directive) => directive.join(" ")).join("; ");
}

/** A 128-bit random nonce, base64-encoded. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Only what the app uses, for this origin only: the camera (PM-Buddy's in-app photo capture,
 * getUserMedia, D6.1), geolocation (GRN delivery position, the photo's GPS fix) and passkeys.
 * The camera viewfinder is a muted video, which `autoplay=()` does not stop.
 */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=(self)",
  "display-capture=()",
  "geolocation=(self)",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "publickey-credentials-create=(self)",
  "publickey-credentials-get=(self)",
  "usb=()",
].join(", ");

/** Two years, every subdomain (ASVS V3.4.1 L2). Not `preload`: that is a domain owner decision. */
export const HSTS = "max-age=63072000; includeSubDomains";

/** The headers besides CSP. HSTS only in production builds (browsers ignore it over HTTP). */
export function securityHeaders(production: boolean): [name: string, value: string][] {
  return [
    ...(production ? [["Strict-Transport-Security", HSTS] as [string, string]] : []),
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    ["Permissions-Policy", PERMISSIONS_POLICY],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
    ["X-Frame-Options", "DENY"],
  ];
}
