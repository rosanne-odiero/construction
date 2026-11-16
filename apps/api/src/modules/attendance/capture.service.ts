import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  captureClockDrift,
  haversineMeters,
  isInsideGeofence,
  isPeriodEditable,
  nairobiDate,
} from "@pm-buddy/domain";
import {
  captureReceiptSchema,
  signedAttendanceEventSchema,
  siteRosterSchema,
  type CaptureReceipt,
  type PushAttendanceEvent,
  type captureReviewSchema,
  type registerSiteDeviceSchema,
  type siteLeaseRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import sharp from "sharp";
import type { z } from "zod";
import type { AttendanceCaptureEvent } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import {
  fromCalendarDate,
  toCalendarDate,
  toGeofenceVersion,
} from "../projects/project-mappers.js";
import {
  AttendanceAccess,
  AttendanceCommands,
  canonicalJson,
  requireStepUp,
  sha256,
} from "./attendance-support.js";
import { AnomalyEvaluator, isEngaged, PeriodStore } from "./period-store.js";

type Flag = CaptureReceipt["flags"][number];
const problem = (code: string, message: string) => new ConflictException({ code, message });
// The site app erases this registration's local data on this exact code (THREAT_MODEL T-38).
const deviceRevoked = () =>
  new ForbiddenException({
    code: "device-revoked",
    message: "Device revoked. The site app erases this registration's local roster and captures.",
  });
const receipt = (row: AttendanceCaptureEvent): CaptureReceipt =>
  captureReceiptSchema.parse(
    row.initialReceipt ?? {
      eventId: row.id,
      receiptId: row.receiptId,
      receivedAt: row.receivedAt.toISOString(),
      status: row.status,
      flags: row.flags,
      // A check-in acknowledges evidence, not a payable day. Quarantine receipts stay immutable
      // after review; allocation is exposed separately on the review queue.
      recordId: row.direction === "out" && row.status === "confirmed" ? row.recordId : null,
    },
  );
const envelope = (row: Pick<AttendanceCaptureEvent, "envelope">) =>
  signedAttendanceEventSchema.parse(row.envelope);
const MINUTE = 60_000;

@Injectable()
export class AttendanceCaptureService {
  constructor(
    private readonly commands: AttendanceCommands,
    private readonly access: AttendanceAccess,
    private readonly policy: AccessPolicy,
    private readonly auth: AuthService,
    private readonly periods: PeriodStore,
    private readonly anomalies: AnomalyEvaluator,
  ) {}

  register(principal: Principal, input: z.infer<typeof registerSiteDeviceSchema>, req: Request) {
    return this.commands.run(
      principal,
      req,
      "attendance.device.register",
      input,
      async (scope) => {
        await this.policy.requireSomewhere(scope, "attendance.record");
        const { tx, access } = scope;
        const existing = await tx.attendanceDevice.findUnique({ where: { id: input.id } });
        if (existing) {
          if (existing.userId !== access.userId || existing.publicKey !== input.publicKey)
            throw problem("device-conflict", "This device identity cannot be reused.");
          if (existing.revokedAt) throw deviceRevoked();
          return { device: existing };
        }
        const device = await tx.attendanceDevice.create({
          data: { ...input, tenantId: access.tenantId, userId: access.userId },
        });
        await this.commands.audit(scope, "attendance.device_registered", device.id);
        return { device };
      },
      // A cached response must never hide a later revocation from the device.
      false,
    );
  }

  revokeDevice(principal: Principal, id: string, req: Request) {
    return this.commands.run(principal, req, "attendance.device.revoke", { id }, async (scope) => {
      const device = await scope.tx.attendanceDevice.findUnique({ where: { id } });
      if (!device) throw new NotFoundException("Device not found");
      if (device.userId !== scope.access.userId) {
        await this.access.requireCompany(scope, "config.manage");
        requireStepUp(this.auth, principal);
      }
      if (!device.revokedAt)
        await scope.tx.attendanceDevice.update({ where: { id }, data: { revokedAt: new Date() } });
      await this.commands.audit(scope, "attendance.device_revoked", id);
      return {
        message:
          "Device revoked. When it next connects, the site app erases this registration's roster, photos and unsynced captures; re-enter unsynced days through corrections.",
      };
    });
  }

  devices(principal: Principal, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      await this.policy.requireSomewhere(scope, "attendance.record");
      return {
        devices: await scope.tx.attendanceDevice.findMany({
          where: {
            tenantId: scope.access.tenantId,
            ...(scope.access.permissions.has("config.manage")
              ? {}
              : { userId: scope.access.userId }),
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
      };
    });
  }

  lease(
    principal: Principal,
    deviceId: string,
    input: z.infer<typeof siteLeaseRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "attendance.device.lease",
      { deviceId, input },
      async (scope) => {
        const { tx, access } = scope;
        await this.ownedDevice(scope, deviceId);
        const ids = await this.access.projectIds(scope, "attendance.record");
        if (!ids.length) throw new ForbiddenException("Attendance recording permission required");
        const now = new Date();
        const lease = await tx.attendanceDeviceLease.create({
          data: {
            ...input,
            deviceTime: new Date(input.deviceTime),
            tenantId: access.tenantId,
            deviceId,
            expiresAt: new Date(now.getTime() + 72 * 3_600_000),
          },
        });
        const projects = await tx.project.findMany({
          where: {
            tenantId: access.tenantId,
            id: { in: ids },
            status: { notIn: ["closed", "cancelled"] },
          },
          select: { id: true, name: true, sites: { select: { id: true, name: true } } },
          orderBy: { name: "asc" },
        });
        const result = [];
        for (const project of projects) {
          const engagements = await tx.labourEngagement.findMany({
            where: {
              tenantId: access.tenantId,
              projectId: project.id,
              startDate: { lte: new Date(now.getTime() + 72 * 3_600_000) },
              OR: [{ endDate: null }, { endDate: { gte: fromCalendarDate(nairobiDate(now)) } }],
            },
            include: {
              labourer: {
                select: {
                  id: true,
                  fullName: true,
                  attendanceCards: { where: { revokedAt: null } },
                },
              },
            },
          });
          result.push({
            ...project,
            workers: engagements.flatMap((engagement) =>
              engagement.labourer.attendanceCards.map((card) => ({
                id: engagement.labourer.id,
                name: engagement.labourer.fullName,
                cardDigest: card.tokenDigest,
                engagementStart: toCalendarDate(engagement.startDate),
                engagementEnd: engagement.endDate ? toCalendarDate(engagement.endDate) : null,
              })),
            ),
          });
        }
        await this.commands.audit(scope, "attendance.device_lease_issued", lease.id, { deviceId });
        return siteRosterSchema.parse({
          lease: {
            ...lease,
            userId: access.userId,
            serverTime: lease.serverTime.toISOString(),
            expiresAt: lease.expiresAt.toISOString(),
            deviceTime: lease.deviceTime.toISOString(),
          },
          projects: result,
        });
      },
    );
  }

  issueCard(principal: Principal, labourerId: string, req: Request) {
    // Deliberately no generic idempotency cache: the printable token must not be stored in JSON
    // response caches. Reissuance revokes every older card atomically.
    return this.commands.run(
      principal,
      req,
      "attendance.card.issue",
      { labourerId },
      async (scope) => {
        await this.policy.requireSomewhere(scope, "labour.manage");
        const { tx, access } = scope;
        const worker = await tx.labourer.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: labourerId } },
        });
        if (!worker) throw new NotFoundException("Worker not found");
        await tx.attendanceWorkerCard.updateMany({
          where: { tenantId: access.tenantId, labourerId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        const token = `PMB1:${randomBytes(32).toString("hex")}`;
        const card = await tx.attendanceWorkerCard.create({
          data: {
            tenantId: access.tenantId,
            labourerId,
            tokenDigest: sha256(token),
            issuedBy: access.userId,
          },
        });
        await this.commands.audit(scope, "attendance.card_issued", card.id, { labourerId });
        return { card: { id: card.id, labourerId, token, issuedAt: card.issuedAt.toISOString() } };
      },
      false,
    );
  }

  revokeCard(principal: Principal, id: string, req: Request) {
    return this.commands.run(principal, req, "attendance.card.revoke", { id }, async (scope) => {
      await this.policy.requireSomewhere(scope, "labour.manage");
      const card = await scope.tx.attendanceWorkerCard.findUnique({ where: { id } });
      if (!card) throw new NotFoundException("Card not found");
      if (!card.revokedAt)
        await scope.tx.attendanceWorkerCard.update({
          where: { id },
          data: { revokedAt: new Date() },
        });
      await this.commands.audit(scope, "attendance.card_revoked", id);
      return { message: "Card revoked. Already captured evidence is retained for review." };
    });
  }

  cards(principal: Principal, projectId: string, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      await this.access.project(scope, projectId, "labour.manage");
      const cards = await scope.tx.attendanceWorkerCard.findMany({
        where: {
          tenantId: scope.access.tenantId,
          labourer: { engagements: { some: { projectId } } },
          revokedAt: null,
        },
        select: { id: true, labourerId: true, issuedAt: true, revokedAt: true },
        orderBy: { issuedAt: "desc" },
        take: 1000,
      });
      return { cards };
    });
  }

  async push(principal: Principal, input: PushAttendanceEvent, req: Request) {
    await this.auth.throttle(req, "attendance-capture", principal.user.id, {
      maximum: 120,
      seconds: 60,
    });
    return this.commands.run(
      principal,
      req,
      "attendance.capture.push",
      input.event,
      async (scope) => {
        const { tx, access } = scope;
        const event = input.event;
        if (event.tenantId !== access.tenantId)
          throw new NotFoundException("Capture scope not found");
        const { project } = await this.access.project(scope, event.projectId, "attendance.record");
        this.access.assertWritable(project);
        const device = await this.ownedDevice(scope, event.deviceId);
        const lease = await tx.attendanceDeviceLease.findFirst({
          where: { tenantId: access.tenantId, id: event.leaseId, deviceId: event.deviceId },
        });
        if (!lease) throw new NotFoundException("Device lease not found");
        const bytes = Buffer.from(canonicalJson(event));
        const publicKey = createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(device.publicKey, "hex"),
          ]),
          format: "der",
          type: "spki",
        });
        if (!verify(null, bytes, publicKey, Buffer.from(input.signature, "hex")))
          throw new ForbiddenException({
            code: "invalid-device-signature",
            message: "Device signature did not verify.",
          });
        const photo = Buffer.from(input.photoBase64, "base64");
        if (
          photo.toString("base64") !== input.photoBase64 ||
          sha256Bytes(photo) !== event.photoSha256
        )
          throw new BadRequestException({
            code: "photo-digest-mismatch",
            message: "The camera photo does not match the signed event.",
          });
        const fingerprint = sha256(canonicalJson({ event, signature: input.signature }));
        const stored = await tx.attendanceCaptureEvent.findUnique({ where: { id: event.id } });
        if (stored) {
          if (stored.fingerprint !== fingerprint)
            throw problem(
              "event-id-reused",
              "This event ID already belongs to different signed evidence.",
            );
          return receipt(stored);
        }
        await this.validatePhoto(photo);
        const site = await tx.site.findFirst({
          where: { tenantId: access.tenantId, id: event.siteId, projectId: event.projectId },
        });
        if (!site) throw new NotFoundException("Site not found");
        const card = await tx.attendanceWorkerCard.findUnique({
          where: { tokenDigest: sha256(event.cardToken) },
        });
        if (!card)
          throw new NotFoundException(
            "Worker card not found; retain this event for authorised recovery",
          );
        const date = nairobiDate(new Date(event.capturedAt));
        const flags = new Set<Flag>();
        const clock = captureClockDrift({
          serverTime: lease.serverTime.toISOString(),
          anchorMonotonicMs: lease.monotonicMs,
          anchorBootId: lease.bootId,
          capturedAt: event.capturedAt,
          monotonicMs: event.monotonicMs,
          bootId: event.bootId,
        });
        if (clock.flagged || Date.parse(event.capturedAt) > Date.now() + 2 * MINUTE)
          flags.add("clock_drift");
        if (!clock.estimatedAt || Date.parse(clock.estimatedAt) > lease.expiresAt.getTime())
          flags.add("lease_expired");
        if (card.revokedAt) flags.add("card_revoked");
        const fence = await tx.siteGeofence.findFirst({
          where: {
            tenantId: access.tenantId,
            siteId: event.siteId,
            effectiveFrom: { lte: new Date(event.capturedAt) },
          },
          orderBy: { version: "desc" },
        });
        if (!event.position || event.position.accuracyM > 50 || !fence)
          flags.add("location_unknown");
        else if (!isInsideGeofence(event.position, toGeofenceVersion(fence).geofence, 30))
          flags.add("outside_geofence");
        const sameShift = await tx.attendanceCaptureEvent.findMany({
          where: { tenantId: access.tenantId, deviceId: event.deviceId, shiftId: event.shiftId },
          orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
        });
        if (sameShift.some((row) => row.direction === event.direction))
          flags.add("duplicate_capture");
        if (
          sameShift.some((row) => row.labourerId !== card.labourerId || row.siteId !== event.siteId)
        )
          flags.add("invalid_shift");
        if (event.direction === "out" && !sameShift.some((row) => row.direction === "in"))
          flags.add("invalid_shift");
        const nearby = await tx.attendanceCaptureEvent.findMany({
          where: {
            tenantId: access.tenantId,
            labourerId: card.labourerId,
            capturedAt: {
              gte: new Date(Date.parse(event.capturedAt) - 24 * 3_600_000),
              lte: new Date(Date.parse(event.capturedAt) + 24 * 3_600_000),
            },
          },
          select: { envelope: true, capturedAt: true, siteId: true },
          orderBy: { capturedAt: "desc" },
        });
        for (const previous of nearby) {
          const other = envelope(previous);
          const elapsed = Math.abs(Date.parse(event.capturedAt) - previous.capturedAt.getTime());
          if (
            other.direction === event.direction &&
            previous.siteId === event.siteId &&
            elapsed < 2 * MINUTE
          )
            flags.add("duplicate_capture");
          if (previous.siteId !== event.siteId && other.position && event.position) {
            const distance = haversineMeters(other.position, event.position);
            const allowance = other.position.accuracyM + event.position.accuracyM;
            if (
              distance - allowance > 1000 &&
              (elapsed === 0 || ((distance - allowance) / elapsed) * 3600 > 200)
            )
              flags.add("impossible_travel");
          }
        }
        const start =
          event.direction === "in" ? event : sameShift.find((row) => row.direction === "in");
        const startEvent = start && ("envelope" in start ? envelope(start) : start);
        if (startEvent && event.direction === "out") {
          const duration = Date.parse(event.capturedAt) - Date.parse(startEvent.capturedAt);
          if (duration < MINUTE || duration >= 24 * 3_600_000) flags.add("invalid_shift");
        }
        const shiftDate = startEvent ? nairobiDate(new Date(startEvent.capturedAt)) : date;
        if (!(await isEngaged(tx, access.tenantId, card.labourerId, event.projectId, shiftDate)))
          throw problem(
            "not-engaged",
            "The card's worker was not engaged on this project on the shift date. Retain the event.",
          );
        const period = await this.periods.covering(tx, access.tenantId, event.projectId, shiftDate);
        if (
          period &&
          !isPeriodEditable(period.status as "open" | "submitted" | "rejected" | "approved")
        )
          flags.add("period_locked");
        const day = await tx.attendanceDay.findUnique({
          where: {
            tenantId_siteId_workDate: {
              tenantId: access.tenantId,
              siteId: event.siteId,
              workDate: fromCalendarDate(shiftDate),
            },
          },
        });
        if (day && day.status !== "draft") flags.add("day_locked");
        if (
          await tx.attendanceRecord.findUnique({
            where: {
              tenantId_siteId_labourerId_workDate: {
                tenantId: access.tenantId,
                siteId: event.siteId,
                labourerId: card.labourerId,
                workDate: fromCalendarDate(shiftDate),
              },
            },
          })
        )
          flags.add("record_exists");
        const row = await tx.attendanceCaptureEvent.create({
          data: {
            id: event.id,
            tenantId: access.tenantId,
            deviceId: event.deviceId,
            leaseId: event.leaseId,
            projectId: event.projectId,
            siteId: event.siteId,
            labourerId: card.labourerId,
            cardId: card.id,
            shiftId: event.shiftId,
            direction: event.direction,
            capturedAt: new Date(event.capturedAt),
            userId: access.userId,
            fingerprint,
            envelope: event,
            signature: input.signature,
            photoEncrypted: await this.auth.security.encrypt(
              input.photoBase64,
              "attendance-camera",
            ),
            status: flags.size ? "quarantined" : "confirmed",
            flags: [...flags],
          },
        });
        await this.commands.audit(scope, "attendance.capture_received", row.id, {
          deviceId: event.deviceId,
          projectId: event.projectId,
          flags: [...flags],
          direction: event.direction,
        });
        await this.materialise(scope, row);
        const fresh = await tx.attendanceCaptureEvent.findUniqueOrThrow({ where: { id: row.id } });
        const durableReceipt = receipt(fresh);
        await tx.attendanceCaptureEvent.update({
          where: { id: row.id },
          data: { initialReceipt: durableReceipt },
        });
        await this.commands.outbox(scope, "attendance.capture_received", row.id, {
          status: row.status,
        });
        return durableReceipt;
      },
      false,
    );
  }

  list(principal: Principal, projectId: string, before: string | undefined, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      await this.access.project(scope, projectId, "attendance.view");
      const cursor = before
        ? await scope.tx.attendanceCaptureEvent.findFirst({
            where: { tenantId: scope.access.tenantId, projectId, id: before },
            select: { id: true },
          })
        : null;
      if (before && !cursor)
        throw new BadRequestException({
          code: "invalid-cursor",
          message: "Capture cursor not found in this project.",
        });
      const events = await scope.tx.attendanceCaptureEvent.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId,
        },
        ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        take: 101,
        include: { card: { include: { labourer: { select: { fullName: true } } } } },
      });
      return {
        events: events.slice(0, 100).map((row) => ({
          event: envelope(row),
          receipt: receipt(row),
          recordId: row.recordId,
          labourerName: row.card.labourer.fullName,
          review: row.decision
            ? {
                decision: row.decision,
                reason: row.reviewReason,
                reviewedAt: row.reviewedAt?.toISOString(),
              }
            : null,
        })),
        nextCursor: events.length > 100 ? events[99]!.id : null,
      };
    });
  }

  review(
    principal: Principal,
    id: string,
    input: z.infer<typeof captureReviewSchema>,
    req: Request,
  ) {
    requireStepUp(this.auth, principal);
    return this.commands.run(
      principal,
      req,
      "attendance.capture.review",
      { id, input },
      async (scope) => {
        const row = await scope.tx.attendanceCaptureEvent.findUnique({ where: { id } });
        if (!row) throw new NotFoundException("Capture not found");
        await this.access.project(scope, row.projectId, "attendance.review_anomalies");
        if (row.userId === scope.access.userId)
          throw problem("same-person", "A different supervisor must review captured evidence.");
        if (row.decision)
          throw problem("capture-already-reviewed", "This evidence was already reviewed.");
        await scope.tx.attendanceCaptureEvent.update({
          where: { id },
          data: {
            decision: input.decision,
            reviewReason: input.reason,
            reviewedBy: scope.access.userId,
            reviewedAt: new Date(),
          },
        });
        if (input.decision === "resolve") await this.materialise(scope, row);
        await this.commands.audit(scope, `attendance.capture_${input.decision}`, id, {
          reasonGiven: true,
        });
        return {
          message:
            "Evidence reviewed. Locked days or existing records still require the normal correction or adjustment workflow.",
        };
      },
    );
  }

  photo(principal: Principal, id: string, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const row = await scope.tx.attendanceCaptureEvent.findUnique({ where: { id } });
      if (!row) throw new NotFoundException("Capture not found");
      await this.access.project(scope, row.projectId, "attendance.view");
      await this.commands.audit(scope, "attendance.capture_photo_viewed", id);
      return Buffer.from(
        await this.auth.security.decrypt(row.photoEncrypted, "attendance-camera"),
        "base64",
      );
    });
  }

  private async ownedDevice(scope: Scope, id: string) {
    const row = await scope.tx.attendanceDevice.findUnique({ where: { id } });
    if (!row || row.userId !== scope.access.userId) throw new NotFoundException("Device not found");
    if (row.revokedAt) throw deviceRevoked();
    return row;
  }

  private async materialise(scope: Scope, row: AttendanceCaptureEvent) {
    const { tx, access } = scope;
    const pair = await tx.attendanceCaptureEvent.findMany({
      where: { tenantId: access.tenantId, deviceId: row.deviceId, shiftId: row.shiftId },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    });
    const start = pair.find((item) => item.direction === "in");
    const end = pair.find((item) => item.direction === "out");
    if (!start || !end || pair.some((item) => item.recordId)) return;
    if (
      [start, end].some(
        (item) =>
          item.decision === "dismiss" ||
          (item.status === "quarantined" && item.decision !== "resolve"),
      )
    )
      return;
    if (start.labourerId !== end.labourerId || start.siteId !== end.siteId) return;
    const duration = end.capturedAt.getTime() - start.capturedAt.getTime();
    const date = nairobiDate(start.capturedAt);
    if (date > nairobiDate() || duration < MINUTE || duration >= 24 * 3_600_000) return;
    const { project } = await this.access.projectAny(scope, row.projectId, [
      "attendance.record",
      "attendance.review_anomalies",
    ]);
    this.access.assertWritable(project);
    const existing = await tx.attendanceRecord.findUnique({
      where: {
        tenantId_siteId_labourerId_workDate: {
          tenantId: access.tenantId,
          siteId: row.siteId,
          labourerId: row.labourerId,
          workDate: fromCalendarDate(date),
        },
      },
    });
    if (existing) return; // Evidence is retained; no implicit overwrite or last-write-wins.
    const covering = await this.periods.covering(tx, access.tenantId, row.projectId, date);
    if (
      covering &&
      !isPeriodEditable(covering.status as "open" | "submitted" | "rejected" | "approved")
    )
      return;
    let day = await tx.attendanceDay.findUnique({
      where: {
        tenantId_siteId_workDate: {
          tenantId: access.tenantId,
          siteId: row.siteId,
          workDate: fromCalendarDate(date),
        },
      },
    });
    if (day && day.status !== "draft") return;
    const event = envelope(start);
    const clockMinutes = (at: Date) => {
      const local = new Date(at.getTime() + 3 * 3_600_000);
      return local.getUTCHours() * 60 + local.getUTCMinutes();
    };
    const checkIn = clockMinutes(start.capturedAt);
    const checkOut = clockMinutes(end.capturedAt);
    const overnight = nairobiDate(end.capturedAt) !== date;
    // The existing minute-level timesheet contract cannot represent zero/full-day rounded spans.
    if ((!overnight && checkOut <= checkIn) || (overnight && checkOut >= checkIn)) return;
    const { period, created } = await this.periods.ensure(
      tx,
      access.tenantId,
      row.projectId,
      date,
      start.userId,
    );
    if (created)
      await this.commands.audit(scope, "timesheet.period_created", period.id, {
        projectId: row.projectId,
      });
    if (!day)
      day = await tx.attendanceDay.create({
        data: {
          tenantId: access.tenantId,
          projectId: row.projectId,
          siteId: row.siteId,
          workDate: fromCalendarDate(date),
          periodId: period.id,
          createdBy: start.userId,
        },
      });
    const fence = await tx.siteGeofence.findFirst({
      where: {
        tenantId: access.tenantId,
        siteId: row.siteId,
        effectiveFrom: { lte: start.capturedAt },
      },
      orderBy: { version: "desc" },
    });
    const record = await tx.attendanceRecord.create({
      data: {
        tenantId: access.tenantId,
        dayId: day.id,
        projectId: row.projectId,
        siteId: row.siteId,
        workDate: fromCalendarDate(date),
        labourerId: row.labourerId,
        status: "present",
        checkInMinutes: checkIn,
        checkOutMinutes: checkOut,
        overnight,
        captureMethod: "qr_card",
        deviceId: row.deviceId,
        deviceTime: start.capturedAt,
        latitude: event.position?.lat,
        longitude: event.position?.lng,
        accuracyM: event.position?.accuracyM,
        geofenceResult: start.flags.includes("outside_geofence")
          ? "outside"
          : start.flags.includes("location_unknown")
            ? "unknown"
            : "inside",
        geofenceVersion: fence?.version,
        clientEventId: start.id,
        createdBy: start.userId,
        updatedBy: start.userId,
      },
    });
    await tx.attendanceCaptureEvent.updateMany({
      where: { id: { in: [start.id, end.id] } },
      data: { recordId: record.id },
    });
    await tx.attendanceDay.update({ where: { id: day.id }, data: { version: { increment: 1 } } });
    await this.anomalies.refresh(tx, access.tenantId, [{ labourerId: row.labourerId, date }]);
    await this.commands.audit(scope, "attendance.capture_allocated", record.id, {
      checkInEventId: start.id,
      checkOutEventId: end.id,
    });
  }

  private async validatePhoto(photo: Buffer) {
    const message = {
      code: "invalid-capture-photo",
      message: "Use a valid camera JPEG no larger than 36 KiB and one megapixel.",
    };
    if (photo.length > 36_864) throw new BadRequestException(message);
    try {
      const metadata = await sharp(photo, { limitInputPixels: 1_048_576 }).metadata();
      if (metadata.format !== "jpeg" || !metadata.width || !metadata.height)
        throw new BadRequestException(message);
      await sharp(photo, { limitInputPixels: 1_048_576 }).resize(1, 1).raw().toBuffer();
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(message, { cause: error });
    }
  }
}

const sha256Bytes = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
