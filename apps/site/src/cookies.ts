export type Cookie = {
  name: string;
  value: string;
  path: string;
  expires: number | null;
  secure: boolean;
};

export function responseCookies(response: {
  headers: unknown;
  _rawHeaders?: [string, string][];
}): string[] {
  const headers = response.headers as { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  // SDK 55 exposes lossless native tuples; RN's global whatwg Headers combines cookies.
  if (Array.isArray(response._rawHeaders)) {
    return response._rawHeaders
      .filter(([name]) => name.toLowerCase() === "set-cookie")
      .map(([, value]) => value);
  }
  throw new Error(
    "Lossless native cookie headers unavailable. Use the supported Expo native build.",
  );
}

/** Deliberately host-only. Domain cookies are accepted only for the exact configured API host. */
export function mergeCookies(
  existing: Cookie[],
  headers: string[],
  url: URL,
  now = Date.now(),
): Cookie[] {
  const jar = existing.filter((cookie) => cookie.expires === null || cookie.expires > now);
  for (const header of headers) {
    const [pair, ...attributes] = header.split(";");
    const equal = pair?.indexOf("=") ?? -1;
    if (!pair || equal < 1) throw new Error("Invalid session cookie.");
    const name = pair.slice(0, equal).trim();
    const value = pair.slice(equal + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\r\n;]/.test(value)) {
      throw new Error("Invalid session cookie.");
    }
    let path = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) || "/";
    let expires: number | null = null;
    let maxAge: number | null = null;
    let secure = false;
    let domainAttribute = false;
    for (const attribute of attributes) {
      const split = attribute.indexOf("=");
      const key = (split < 0 ? attribute : attribute.slice(0, split)).trim().toLowerCase();
      const val = split < 0 ? "" : attribute.slice(split + 1).trim();
      if (key === "domain") domainAttribute = true;
      if (key === "domain" && val.replace(/^\./, "").toLowerCase() !== url.hostname.toLowerCase()) {
        throw new Error("Refusing session cookie for a different host.");
      }
      if (key === "path" && val.startsWith("/")) path = val;
      if (key === "secure") secure = true;
      if (key === "max-age" && /^-?\d+$/.test(val)) maxAge = Number(val);
      if (key === "expires" && Number.isFinite(Date.parse(val))) expires = Date.parse(val);
    }
    if (maxAge !== null) expires = now + maxAge * 1_000;
    if (secure && url.protocol !== "https:") throw new Error("Secure cookie requires HTTPS.");
    if (name.startsWith("__Secure-") && !secure) throw new Error("Invalid secure cookie.");
    if (name.startsWith("__Host-") && (!secure || path !== "/" || domainAttribute))
      throw new Error("Invalid host cookie.");
    const old = jar.findIndex((cookie) => cookie.name === name && cookie.path === path);
    if (old >= 0) jar.splice(old, 1);
    if (expires === null || expires > now) jar.push({ name, value, path, expires, secure });
  }
  return jar;
}

export function cookieHeader(jar: Cookie[], url: URL, now = Date.now()): string {
  return jar
    .filter(
      (cookie) =>
        (cookie.expires === null || cookie.expires > now) &&
        (!cookie.secure || url.protocol === "https:") &&
        (url.pathname === cookie.path ||
          url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`)),
    )
    .sort((a, b) => b.path.length - a.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function validateEndpoints(
  api: string | undefined,
  origin: string | undefined,
  development: boolean,
) {
  if (!api || !origin) throw new Error("Configure EXPO_PUBLIC_API_URL and EXPO_PUBLIC_WEB_ORIGIN.");
  const apiUrl = new URL(api);
  const webUrl = new URL(origin);
  for (const url of [apiUrl, webUrl]) {
    const local = ["localhost", "127.0.0.1", "10.0.2.2", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(development && local && url.protocol === "http:")) {
      throw new Error("HTTPS required (HTTP allowed only on local development loopback/emulator).");
    }
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Invalid endpoint URL.");
  }
  if (webUrl.pathname !== "/") throw new Error("WEB_ORIGIN must be an origin, without a path.");
  return { api: apiUrl.toString().replace(/\/$/, ""), origin: webUrl.origin };
}
