import { z } from "zod";
import { authResponseSchema, MAX_PASSKEYS } from "./identity.js";

/**
 * Passkey (WebAuthn) wire contracts (ARCHITECTURE §7). The option shapes mirror the W3C JSON
 * serialisations that @simplewebauthn/server produces and @simplewebauthn/browser consumes; the
 * API always demands user verification, so any other value is a contract violation.
 */
const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const base64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);
/** WebAuthn caps credential IDs at 1023 bytes: 1364 base64url characters. */
const credentialId = base64url(1364);

export const PASSKEY_TRANSPORTS = [
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
] as const;
export const passkeyTransportSchema = z.enum(PASSKEY_TRANSPORTS);
export type PasskeyTransport = z.infer<typeof passkeyTransportSchema>;
export const isPasskeyTransport = (value: string): value is PasskeyTransport =>
  (PASSKEY_TRANSPORTS as readonly string[]).includes(value);

export const passkeyNameSchema = z.string().trim().min(1).max(60);

export const passkeySchema = z
  .object({
    id: uuid,
    name: passkeyNameSchema,
    createdAt: timestamp,
    lastUsedAt: timestamp.nullable(),
    backedUp: z.boolean(),
    deviceType: z.enum(["singleDevice", "multiDevice"]),
  })
  .strict();
export const passkeysResponseSchema = z
  .object({ passkeys: z.array(passkeySchema).max(MAX_PASSKEYS) })
  .strict();

const credentialDescriptor = z
  .object({
    id: credentialId,
    type: z.literal("public-key"),
    transports: z.array(passkeyTransportSchema).max(PASSKEY_TRANSPORTS.length).optional(),
  })
  .strict();
const hints = z.array(z.enum(["security-key", "client-device", "hybrid"])).max(3);

export const passkeyRegistrationOptionsSchema = z
  .object({
    challenge: base64url(128),
    rp: z.object({ name: z.string().min(1).max(64), id: z.string().min(1).max(253) }).strict(),
    user: z
      .object({
        id: base64url(128),
        name: z.string().min(1).max(254),
        displayName: z.string().max(100),
      })
      .strict(),
    pubKeyCredParams: z
      .array(z.object({ alg: z.number().int(), type: z.literal("public-key") }).strict())
      .min(1)
      .max(10),
    timeout: z.number().int().positive().max(600_000).optional(),
    attestation: z.literal("none").optional(),
    excludeCredentials: z.array(credentialDescriptor).max(MAX_PASSKEYS).optional(),
    authenticatorSelection: z
      .object({
        authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
        residentKey: z.enum(["discouraged", "preferred", "required"]).optional(),
        requireResidentKey: z.boolean().optional(),
        userVerification: z.literal("required"),
      })
      .strict(),
    extensions: z.object({ credProps: z.boolean().optional() }).strict().optional(),
    hints: hints.optional(),
  })
  .strict();
export const passkeyRegistrationOptionsResponseSchema = z
  .object({ options: passkeyRegistrationOptionsSchema })
  .strict();

export const passkeyAuthenticationOptionsSchema = z
  .object({
    challenge: base64url(128),
    rpId: z.string().min(1).max(253),
    allowCredentials: z.array(credentialDescriptor).min(1).max(MAX_PASSKEYS),
    timeout: z.number().int().positive().max(600_000).optional(),
    userVerification: z.literal("required"),
    extensions: z.object({}).strict().optional(),
    hints: hints.optional(),
  })
  .strict();
export const passkeyAuthenticationOptionsResponseSchema = z
  .object({ options: passkeyAuthenticationOptionsSchema })
  .strict();

/** Browsers may report transports this list does not know yet; they are ignored, not refused. */
const reportedTransports = z
  .array(z.string().max(32))
  .max(16)
  .transform((values) => values.filter(isPasskeyTransport));
const clientExtensionResults = z.record(z.string().max(64), z.json());
const attachment = z.enum(["platform", "cross-platform"]).optional();

/** RegistrationResponseJSON from navigator.credentials.create(), as @simplewebauthn/browser sends it. */
export const passkeyRegistrationCredentialSchema = z
  .object({
    id: credentialId,
    rawId: credentialId,
    type: z.literal("public-key"),
    response: z
      .object({
        clientDataJSON: base64url(4096),
        attestationObject: base64url(32_768),
        authenticatorData: base64url(16_384).optional(),
        transports: reportedTransports.optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: base64url(8192).optional(),
      })
      .strict(),
    authenticatorAttachment: attachment,
    clientExtensionResults,
  })
  .strict();

/** AuthenticationResponseJSON from navigator.credentials.get(). */
export const passkeyAuthenticationCredentialSchema = z
  .object({
    id: credentialId,
    rawId: credentialId,
    type: z.literal("public-key"),
    response: z
      .object({
        clientDataJSON: base64url(4096),
        authenticatorData: base64url(16_384),
        signature: base64url(8192),
        userHandle: base64url(128).optional(),
      })
      .strict(),
    authenticatorAttachment: attachment,
    clientExtensionResults,
  })
  .strict();

export const passkeyRegistrationRequestSchema = z
  .object({ name: passkeyNameSchema, credential: passkeyRegistrationCredentialSchema })
  .strict();
export const passkeyAuthenticationRequestSchema = z
  .object({ credential: passkeyAuthenticationCredentialSchema })
  .strict();

/** A registered passkey; recovery codes come back once, when it is the account's first factor. */
export const passkeyRegistrationResponseSchema = authResponseSchema
  .extend({
    passkey: passkeySchema,
    recoveryCodes: z.array(z.string().min(16).max(64)).length(10).optional(),
  })
  .strict();

export type Passkey = z.infer<typeof passkeySchema>;
export type PasskeysResponse = z.infer<typeof passkeysResponseSchema>;
export type PasskeyRegistrationOptions = z.infer<typeof passkeyRegistrationOptionsSchema>;
export type PasskeyAuthenticationOptions = z.infer<typeof passkeyAuthenticationOptionsSchema>;
export type PasskeyRegistrationCredential = z.infer<typeof passkeyRegistrationCredentialSchema>;
export type PasskeyAuthenticationCredential = z.infer<typeof passkeyAuthenticationCredentialSchema>;
export type PasskeyRegistrationRequest = z.infer<typeof passkeyRegistrationRequestSchema>;
export type PasskeyAuthenticationRequest = z.infer<typeof passkeyAuthenticationRequestSchema>;
export type PasskeyRegistrationResponse = z.infer<typeof passkeyRegistrationResponseSchema>;
