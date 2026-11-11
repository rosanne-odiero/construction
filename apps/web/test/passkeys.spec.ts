import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { WEB_PORT } from "./live-helpers";

/**
 * Passkey UI against a mocked API, with Chromium's virtual authenticator (CDP WebAuthn domain)
 * performing the real browser ceremonies. WebAuthn refuses IP-address origins, so these pages
 * load from localhost rather than 127.0.0.1.
 */
const origin = `http://localhost:${WEB_PORT}`;
const userId = "20000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000002";
const passkeyId = "20000000-0000-4000-8000-000000000003";
const timestamp = "2026-11-10T12:00:00.000Z";
const registrationChallenge = "c3ludGhldGljLXJlZ2lzdHJhdGlvbi1jaGFsbGVuZ2U";
const stepUpChallenge = "c3ludGhldGljLXN0ZXAtdXAtY2hhbGxlbmdl";
const axeTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

type Credential = {
  id: string;
  rawId: string;
  type: string;
  response: Record<string, string | string[] | number | undefined>;
  clientExtensionResults: unknown;
};
const clientData = (credential: Credential) =>
  JSON.parse(
    Buffer.from(String(credential.response["clientDataJSON"]), "base64url").toString(),
  ) as {
    type: string;
    challenge: string;
    origin: string;
  };

/**
 * Scans the page at rest, like the other foundation tests: the pointer leaves the last button it
 * clicked and CSS transitions (buttons re-enabled after a request) finish first.
 */
async function scan(page: Page) {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  return (await new AxeBuilder({ page }).withTags(axeTags).analyze()).violations;
}

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

test("registers, lists, uses and removes a passkey with Chromium's virtual authenticator", async ({
  page,
}) => {
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  let credentialId: string | null = null;
  let mfaVerified = false;
  let removed = false;
  const calls: string[] = [];
  const unexpected: string[] = [];
  const account = () => ({
    user: {
      id: userId,
      identifier: "passkey.owner@example.invalid",
      displayName: "Synthetic Passkey User",
      verified: true,
      mfaEnabled: credentialId !== null && !removed,
      totpEnabled: false,
      passkeys: credentialId !== null && !removed ? 1 : 0,
    },
    session: { id: sessionId, tenantId: null, mfaVerified, expiresAt: timestamp },
    mfaRequired: false,
  });
  const passkey = () => ({
    id: passkeyId,
    name: "Site phone",
    createdAt: timestamp,
    lastUsedAt: mfaVerified ? timestamp : null,
    backedUp: false,
    deviceType: "singleDevice",
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const method = request.method();
    calls.push(`${method} ${path}`);
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (method !== "GET") expect(request.headers()["x-csrf-token"]).toBe("synthetic-csrf");
    if (path === "/auth/csrf") return json({ csrfToken: "synthetic-csrf" });
    if (path === "/auth/me") return json(account());
    if (path === "/tenants") return json({ tenants: [] });
    if (path === "/auth/sessions")
      return json({
        sessions: [
          {
            id: sessionId,
            createdAt: timestamp,
            lastSeenAt: timestamp,
            expiresAt: timestamp,
            current: true,
          },
        ],
      });
    if (path === "/auth/passkeys" && method === "GET")
      return json({ passkeys: credentialId && !removed ? [passkey()] : [] });
    if (path === "/auth/passkeys/registration/options")
      return json({
        options: {
          challenge: registrationChallenge,
          rp: { name: "PM-Buddy", id: "localhost" },
          user: {
            id: "IAAAAAAAQACAAAAAAAAAAQ",
            name: "passkey.owner@example.invalid",
            displayName: "Synthetic Passkey User",
          },
          pubKeyCredParams: [
            { alg: -7, type: "public-key" },
            { alg: -257, type: "public-key" },
          ],
          timeout: 300_000,
          attestation: "none",
          excludeCredentials: [],
          authenticatorSelection: {
            residentKey: "preferred",
            requireResidentKey: false,
            userVerification: "required",
          },
          extensions: { credProps: true },
          hints: [],
        },
      });
    if (path === "/auth/passkeys/registration") {
      const body = request.postDataJSON() as { name: string; credential: Credential };
      expect(body.name).toBe("Site phone");
      expect(body.credential.type).toBe("public-key");
      expect(body.credential.rawId).toBe(body.credential.id);
      expect(body.credential.response["attestationObject"]).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(clientData(body.credential)).toMatchObject({
        type: "webauthn.create",
        challenge: registrationChallenge,
        origin,
      });
      credentialId = body.credential.id;
      mfaVerified = true;
      return json(
        {
          ...account(),
          passkey: passkey(),
          recoveryCodes: Array.from(
            { length: 10 },
            (_, index) => `synthetic-passkey-recovery-${String(index + 1).padStart(2, "0")}`,
          ),
        },
        201,
      );
    }
    if (path === "/auth/passkeys/step-up/options")
      return json({
        options: {
          challenge: stepUpChallenge,
          rpId: "localhost",
          allowCredentials: [{ id: credentialId, type: "public-key", transports: ["internal"] }],
          timeout: 300_000,
          userVerification: "required",
        },
      });
    if (path === "/auth/passkeys/step-up") {
      const { credential } = request.postDataJSON() as { credential: Credential };
      expect(credential.id).toBe(credentialId);
      expect(credential.response["signature"]).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(credential.response["authenticatorData"]).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(clientData(credential)).toMatchObject({
        type: "webauthn.get",
        challenge: stepUpChallenge,
        origin,
      });
      mfaVerified = true;
      return json(account());
    }
    if (path === `/auth/passkeys/${passkeyId}` && method === "DELETE") {
      removed = true;
      return json({ message: "Passkey removed." });
    }
    unexpected.push(`${method} ${path}`);
    return json({ code: "not-found" }, 404);
  });

  await page.goto(`${origin}/foundation`);
  await expect(
    page.getByText("Signed in as Synthetic Passkey User", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Passkeys" })).toBeVisible();
  await expect(page.getByText("No passkeys yet.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Verify with a passkey" })).toHaveCount(0);

  await page.locator("#passkey-name").fill("Site phone");
  await page.getByRole("button", { name: "Add passkey", exact: true }).click();
  await expect(page.getByText("synthetic-passkey-recovery-01", { exact: true })).toBeVisible();
  await expect(page.locator('main [role="status"]').last()).toContainText("Passkey added.");
  await expect(page.getByText("Site phone", { exact: true })).toBeVisible();
  const stored = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(stored.credentials).toHaveLength(1);
  expect(stored.credentials[0]!.rpId).toBe("localhost");
  expect(Buffer.from(stored.credentials[0]!.credentialId, "base64").toString("base64url")).toBe(
    credentialId,
  );
  expect(await scan(page)).toEqual([]);
  await page.getByRole("button", { name: "I saved the codes; hide them" }).click();

  // A prompt the authenticator cannot complete (no user verification) sends nothing to the API.
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  await page.getByRole("button", { name: "Verify with a passkey" }).click();
  await expect(page.locator('main [role="alert"]')).toContainText("passkey prompt was cancelled");
  expect(calls).not.toContain("POST /auth/passkeys/step-up");
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });

  const before = stored.credentials[0]!.signCount;
  await page.getByRole("button", { name: "Verify with a passkey" }).click();
  await expect(page.getByText("MFA verified. Load the workspace to continue.")).toBeVisible();
  expect(calls).toContain("POST /auth/passkeys/step-up");
  const used = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(used.credentials[0]!.signCount).toBeGreaterThan(before);

  await page.getByRole("button", { name: "Load companies, projects and sessions" }).click();
  await expect(page.getByText(/last used/)).toBeVisible();
  await page.getByRole("button", { name: "Remove Site phone", exact: true }).click();
  await expect(page.getByText("Passkey removed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Site phone" })).toHaveCount(0);
  expect(await scan(page)).toEqual([]);
  expect(unexpected).toEqual([]);
});

for (const locale of ["en", "sw"] as const) {
  test(`explains refused passwords in ${locale} without assuming success`, async ({
    page,
    context,
  }) => {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: origin }]);
    let attempt = 0;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (path === "/auth/me") return json({ code: "unauthorized" }, 401);
      if (path === "/auth/csrf") return json({ csrfToken: "synthetic-csrf" });
      if (path === "/auth/register") {
        attempt += 1;
        return json(
          { code: attempt === 1 ? "password-too-weak" : "password-breached", status: 400 },
          400,
        );
      }
      return json({ code: "not-found" }, 404);
    });
    await page.goto(`${origin}/foundation`);
    await expect(page.locator("#register-displayName")).toBeEnabled();
    const expected =
      locale === "en"
        ? ["too easy to guess", "known data breach"]
        : ["rahisi kukisia", "uvujaji wa data"];
    for (const text of expected) {
      await page.locator("#register-displayName").fill("Synthetic Builder");
      await page.locator("#register-identifier").fill("builder@example.invalid");
      await page.locator("#register-password").fill("synthetic-test-password");
      await page
        .locator("#register-password")
        .locator("xpath=ancestor::form")
        .getByRole("button")
        .click();
      await expect(page.locator('main [role="alert"]')).toContainText(text);
    }
    expect(await scan(page)).toEqual([]);
  });
}
