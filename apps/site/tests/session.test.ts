import assert from "node:assert/strict";
import { test } from "node:test";
import { cookieHeader, mergeCookies, responseCookies, validateEndpoints } from "../src/cookies.ts";

test("SDK 55 native raw tuples preserve separate cookies when RN Headers lacks getSetCookie", () => {
  const cookies = [
    "pmb_at=one; Path=/; Expires=Mon, 16 Nov 2026 00:00:00 GMT",
    "pmb_rt=two; Path=/api/v1/auth; HttpOnly",
  ];
  assert.deepEqual(
    responseCookies({
      headers: {},
      _rawHeaders: [
        ["Set-Cookie", cookies[0]!],
        ["content-type", "application/json"],
        ["set-cookie", cookies[1]!],
      ],
    }),
    cookies,
  );
  assert.deepEqual(responseCookies({ headers: { getSetCookie: () => cookies } }), cookies);
  assert.throws(() => responseCookies({ headers: {} }), /Lossless/);
});

test("cookie jar preserves separate Set-Cookie fields, Expires commas, refresh path, rotation and deletion", () => {
  const url = new URL("https://api.example.test/api/v1/auth/login");
  const now = Date.parse("2026-11-15T00:00:00Z");
  let jar = mergeCookies(
    [],
    [
      "__Host-pmb_at=access; Secure; HttpOnly; Path=/; Max-Age=900",
      "__Secure-pmb_rt=refresh; Secure; HttpOnly; Path=/api/v1/auth; Expires=Mon, 16 Nov 2026 00:00:00 GMT",
    ],
    url,
    now,
  );
  assert.equal(
    cookieHeader(jar, new URL("https://api.example.test/api/v1/attendance/capture/events"), now),
    "__Host-pmb_at=access",
  );
  assert.match(cookieHeader(jar, url, now), /__Secure-pmb_rt=refresh/);
  assert.doesNotMatch(
    cookieHeader(jar, new URL("https://api.example.test/api/v1/authentication"), now),
    /refresh/,
  );
  jar = mergeCookies(jar, ["__Host-pmb_at=rotated; Path=/; Secure; Max-Age=900"], url, now);
  assert.match(cookieHeader(jar, url, now), /rotated/);
  jar = mergeCookies(jar, ["__Host-pmb_at=; Path=/; Secure; Max-Age=0"], url, now);
  assert.doesNotMatch(cookieHeader(jar, url, now), /pmb_at/);
  assert.equal(cookieHeader(jar, url, now + 2 * 86_400_000), "");
});

test("reject foreign-domain cookies and insecure host cookies", () => {
  const https = new URL("https://api.example.test/api/v1/auth/login");
  assert.throws(() => mergeCookies([], ["pmb_at=a; Domain=evil.test"], https), /different host/);
  assert.throws(() => mergeCookies([], ["__Host-pmb_at=a; Path=/"], https), /host cookie/);
  assert.throws(
    () => mergeCookies([], ["pmb_at=a; Secure"], new URL("http://localhost/api/v1/auth/login")),
    /HTTPS/,
  );
});

test("API endpoint and WEB_ORIGIN are separate; production never permits HTTP", () => {
  assert.deepEqual(
    validateEndpoints("https://api.example.test/api/v1", "https://app.example.test", false),
    {
      api: "https://api.example.test/api/v1",
      origin: "https://app.example.test",
    },
  );
  assert.doesNotThrow(() =>
    validateEndpoints("http://10.0.2.2:4000/api/v1", "http://localhost:3000", true),
  );
  assert.throws(
    () => validateEndpoints("http://10.0.2.2:4000/api/v1", "http://localhost:3000", false),
    /HTTPS/,
  );
  assert.throws(
    () => validateEndpoints("http://192.168.1.3:4000/api/v1", "https://app.example.test", true),
    /HTTPS/,
  );
  assert.throws(
    () =>
      validateEndpoints("https://api.example.test/api/v1", "https://app.example.test/path", false),
    /origin/,
  );
});
