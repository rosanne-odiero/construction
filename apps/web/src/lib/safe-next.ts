const BASE = "http://pm-buddy.invalid";

/**
 * The post-sign-in destination: only a same-site relative path is accepted (no scheme, host,
 * protocol-relative `//` or backslash tricks), so `?next=` can never become an open redirect.
 */
export function safeNextPath(value: unknown, fallback = "/projects"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value))
    return fallback;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return fallback;
  }
  // Check the normalised path as well: dot segments ("/.//x", "/%2e%2e//x") can collapse into a
  // protocol-relative "//host" that the browser would treat as another site.
  if (
    url.origin !== BASE ||
    url.pathname.startsWith("//") ||
    url.pathname.includes("\\") ||
    url.pathname === "/sign-in" ||
    url.pathname.startsWith("/api/")
  )
    return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in page URL that returns to `path` afterwards. */
export const signInHref = (path: string): string =>
  `/sign-in?next=${encodeURIComponent(safeNextPath(path))}`;
