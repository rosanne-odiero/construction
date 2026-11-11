import { describe, expect, it } from "vitest";
import {
  PASSWORD_PROBLEM_CODES,
  apiEnvSchema,
  authResponseSchema,
  passkeyAuthenticationOptionsResponseSchema,
  passkeyAuthenticationRequestSchema,
  passkeyRegistrationOptionsResponseSchema,
  passkeyRegistrationRequestSchema,
  passkeyRegistrationResponseSchema,
  passkeysResponseSchema,
  type AuthResponse,
} from "./index.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const date = "2026-11-10T20:00:00.000Z";
const auth: AuthResponse = {
  user: {
    id,
    identifier: "builder@example.test",
    displayName: "Builder",
    verified: true,
    mfaEnabled: true,
    totpEnabled: false,
    passkeys: 1,
  },
  session: { id, tenantId: null, mfaVerified: true, expiresAt: date },
  mfaRequired: false,
};
const passkey = {
  id,
  name: "Site phone",
  createdAt: date,
  lastUsedAt: null,
  backedUp: true,
  deviceType: "multiDevice",
};
const registrationOptions = {
  challenge: "c2ludGhldGljLWNoYWxsZW5nZQ",
  rp: { name: "PM-Buddy", id: "localhost" },
  user: { id: "dXNlcg", name: "builder@example.test", displayName: "Builder" },
  pubKeyCredParams: [
    { alg: -8, type: "public-key" },
    { alg: -7, type: "public-key" },
  ],
  timeout: 300_000,
  attestation: "none",
  excludeCredentials: [{ id: "Y3JlZA", type: "public-key", transports: ["internal"] }],
  authenticatorSelection: {
    residentKey: "preferred",
    requireResidentKey: false,
    userVerification: "required",
  },
  extensions: { credProps: true },
  hints: [],
};
const authenticationOptions = {
  challenge: "c2ludGhldGljLWNoYWxsZW5nZQ",
  rpId: "localhost",
  allowCredentials: [{ id: "Y3JlZA", type: "public-key", transports: ["internal", "hybrid"] }],
  timeout: 300_000,
  userVerification: "required",
};
const registrationCredential = {
  id: "Y3JlZA",
  rawId: "Y3JlZA",
  type: "public-key",
  response: {
    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0",
    attestationObject: "o2NmbXRkbm9uZQ",
    transports: ["internal"],
    publicKeyAlgorithm: -7,
  },
  authenticatorAttachment: "platform",
  clientExtensionResults: { credProps: { rk: true } },
};
const assertion = {
  id: "Y3JlZA",
  rawId: "Y3JlZA",
  type: "public-key",
  response: {
    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0",
    authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAQ", // gitleaks:allow (synthetic WebAuthn fixture)
    signature: "MEUCIQ",
    userHandle: "dXNlcg",
  },
  clientExtensionResults: {},
};

describe("Passkey wire contracts", () => {
  it("accepts the shapes the API and the browser library exchange", () => {
    expect(passkeysResponseSchema.parse({ passkeys: [passkey] })).toEqual({ passkeys: [passkey] });
    expect(
      passkeyRegistrationOptionsResponseSchema.parse({ options: registrationOptions }).options,
    ).toEqual(registrationOptions);
    expect(
      passkeyAuthenticationOptionsResponseSchema.parse({ options: authenticationOptions }).options,
    ).toEqual(authenticationOptions);
    expect(
      passkeyRegistrationRequestSchema.parse({
        name: " Site phone ",
        credential: registrationCredential,
      }),
    ).toEqual({ name: "Site phone", credential: registrationCredential });
    expect(passkeyAuthenticationRequestSchema.parse({ credential: assertion })).toEqual({
      credential: assertion,
    });
    const registered = { ...auth, passkey };
    expect(passkeyRegistrationResponseSchema.parse(registered)).toEqual(registered);
    const first = {
      ...registered,
      recoveryCodes: Array.from({ length: 10 }, (_, index) => `recovery-code-${index}-123456789`),
    };
    expect(passkeyRegistrationResponseSchema.parse(first)).toEqual(first);
  });

  it("refuses options that do not demand user verification", () => {
    for (const userVerification of ["preferred", "discouraged", undefined]) {
      expect(
        passkeyRegistrationOptionsResponseSchema.safeParse({
          options: {
            ...registrationOptions,
            authenticatorSelection: { residentKey: "preferred", userVerification },
          },
        }).success,
      ).toBe(false);
      expect(
        passkeyAuthenticationOptionsResponseSchema.safeParse({
          options: { ...authenticationOptions, userVerification },
        }).success,
      ).toBe(false);
    }
    expect(
      passkeyRegistrationOptionsResponseSchema.safeParse({
        options: { ...registrationOptions, attestation: "direct" },
      }).success,
    ).toBe(false);
  });

  it("never exposes credential material in listings and bounds request sizes", () => {
    expect(
      passkeysResponseSchema.safeParse({
        passkeys: [{ ...passkey, credentialId: "Y3JlZA", publicKey: "pQECAyYgASFY" }],
      }).success,
    ).toBe(false);
    expect(
      passkeyAuthenticationRequestSchema.safeParse({
        credential: { ...assertion, response: { ...assertion.response, signature: "not base64!" } },
      }).success,
    ).toBe(false);
    expect(
      passkeyAuthenticationRequestSchema.safeParse({
        credential: { ...assertion, id: "A".repeat(1365), rawId: "A".repeat(1365) },
      }).success,
    ).toBe(false);
    expect(
      passkeyRegistrationRequestSchema.safeParse({
        name: "   ",
        credential: registrationCredential,
      }).success,
    ).toBe(false);
    expect(
      passkeyRegistrationRequestSchema.safeParse({
        name: "Phone",
        credential: registrationCredential,
        userId: id,
      }).success,
    ).toBe(false);
  });

  it("drops transports the shared list does not know instead of refusing the passkey", () => {
    const parsed = passkeyRegistrationRequestSchema.parse({
      name: "Key",
      credential: {
        ...registrationCredential,
        response: { ...registrationCredential.response, transports: ["usb", "future-radio"] },
      },
    });
    expect(parsed.credential.response.transports).toEqual(["usb"]);
  });

  it("reports MFA factors on the account", () => {
    const { passkeys: _removed, ...user } = auth.user;
    expect(authResponseSchema.safeParse({ ...auth, user }).success).toBe(false);
    expect(
      authResponseSchema.safeParse({ ...auth, user: { ...auth.user, passkeys: 11 } }).success,
    ).toBe(false);
  });
});

describe("Password policy and breach-check configuration", () => {
  it("exposes only the two generic refusal codes", () => {
    expect(PASSWORD_PROBLEM_CODES).toEqual(["password-too-weak", "password-breached"]);
  });

  it("defaults the breached-password check to off and accepts only known modes", () => {
    const env = {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      S3_ENDPOINT: "http://localhost:9000",
      S3_BUCKET: "bucket",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
    };
    expect(apiEnvSchema.parse(env).AUTH_BREACHED_PASSWORD_CHECK).toBe("off");
    expect(
      apiEnvSchema.parse({ ...env, AUTH_BREACHED_PASSWORD_CHECK: "hibp" })
        .AUTH_BREACHED_PASSWORD_CHECK,
    ).toBe("hibp");
    expect(apiEnvSchema.safeParse({ ...env, AUTH_BREACHED_PASSWORD_CHECK: "on" }).success).toBe(
      false,
    );
  });
});
