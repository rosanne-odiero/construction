import { z } from "zod";

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const hex = (length: number) => z.string().regex(new RegExp(`^[a-f0-9]{${length}}$`));
export const workerCardTokenSchema = z.string().regex(/^PMB1:[a-f0-9]{64}$/);
export const registerSiteDeviceSchema = z
  .object({ id: uuid, name: z.string().trim().min(2).max(100), publicKey: hex(64) })
  .strict();
export const siteLeaseRequestSchema = z
  .object({
    bootId: uuid,
    deviceTime: timestamp,
    monotonicMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const siteLeaseSchema = z
  .object({
    id: uuid,
    deviceId: uuid,
    tenantId: uuid,
    userId: uuid,
    serverTime: timestamp,
    expiresAt: timestamp,
    bootId: uuid,
    deviceTime: timestamp,
    monotonicMs: z.number().finite().nonnegative(),
  })
  .strict();
export type SiteLease = z.infer<typeof siteLeaseSchema>;
export const sitePositionSchema = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    accuracyM: z.number().finite().min(0).max(999999),
  })
  .strict();
export const signedAttendanceEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: uuid,
    deviceId: uuid,
    leaseId: uuid,
    tenantId: uuid,
    projectId: uuid,
    siteId: uuid,
    bootId: uuid,
    monotonicMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    capturedAt: timestamp,
    direction: z.enum(["in", "out"]),
    shiftId: uuid,
    cardToken: workerCardTokenSchema,
    method: z.enum(["qr_card", "nfc_card"]),
    position: sitePositionSchema.nullable(),
    photoSha256: hex(64),
    supervisorConfirmed: z.literal(true),
  })
  .strict();
export type SignedAttendanceEvent = z.infer<typeof signedAttendanceEventSchema>;
export const pushAttendanceEventSchema = z
  .object({
    event: signedAttendanceEventSchema,
    signature: hex(128),
    // Small camera JPEGs keep one event below the existing API JSON-body limit.
    photoBase64: z
      .string()
      .min(4)
      .max(49152)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type PushAttendanceEvent = z.infer<typeof pushAttendanceEventSchema>;
export const CAPTURE_FLAGS = [
  "clock_drift",
  "lease_expired",
  "location_unknown",
  "outside_geofence",
  "duplicate_capture",
  "impossible_travel",
  "period_locked",
  "day_locked",
  "record_exists",
  "invalid_shift",
  "card_revoked",
] as const;
export const captureReceiptSchema = z
  .object({
    eventId: uuid,
    receiptId: uuid,
    receivedAt: timestamp,
    status: z.enum(["confirmed", "quarantined"]),
    flags: z.array(z.enum(CAPTURE_FLAGS)),
    recordId: uuid.nullable(),
  })
  .strict();
export type CaptureReceipt = z.infer<typeof captureReceiptSchema>;
export const captureReviewSchema = z
  .object({
    decision: z.enum(["resolve", "dismiss"]),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();
export const siteRosterSchema = z
  .object({
    lease: siteLeaseSchema,
    projects: z.array(
      z
        .object({
          id: uuid,
          name: z.string(),
          sites: z.array(z.object({ id: uuid, name: z.string() }).strict()),
          workers: z.array(
            z
              .object({
                id: uuid,
                name: z.string(),
                cardDigest: hex(64),
                engagementStart: z.iso.date(),
                engagementEnd: z.iso.date().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type SiteRoster = z.infer<typeof siteRosterSchema>;
export const siteDeviceSchema = z
  .object({
    id: uuid,
    tenantId: uuid,
    userId: uuid,
    name: z.string(),
    publicKey: hex(64),
    createdAt: timestamp,
    revokedAt: timestamp.nullable(),
  })
  .strict();
export const siteDeviceResponseSchema = z.object({ device: siteDeviceSchema }).strict();
export const siteDevicesResponseSchema = z.object({ devices: z.array(siteDeviceSchema) }).strict();
export const workerCardResponseSchema = z
  .object({
    card: z
      .object({ id: uuid, labourerId: uuid, token: workerCardTokenSchema, issuedAt: timestamp })
      .strict(),
  })
  .strict();
export const workerCardsResponseSchema = z
  .object({
    cards: z.array(
      z
        .object({
          id: uuid,
          labourerId: uuid,
          issuedAt: timestamp,
          revokedAt: timestamp.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export const captureQueueResponseSchema = z
  .object({
    events: z.array(
      z
        .object({
          event: signedAttendanceEventSchema,
          receipt: captureReceiptSchema,
          recordId: uuid.nullable(),
          labourerName: z.string(),
          review: z
            .object({
              decision: z.enum(["resolve", "dismiss"]),
              reason: z.string(),
              reviewedAt: timestamp,
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    nextCursor: uuid.nullable(),
  })
  .strict();
export type CaptureQueue = z.infer<typeof captureQueueResponseSchema>;
