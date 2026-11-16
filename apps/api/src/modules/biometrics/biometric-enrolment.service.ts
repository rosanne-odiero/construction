import { randomUUID } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import { biometricGate, looksLikeImage, nairobiDate } from "@pm-buddy/domain";
import { BIOMETRIC_CONSENT_KINDS, currentConsentNotice, type Permission } from "@pm-buddy/types";
import type {
  BiometricDeletionsResponse,
  BiometricEnrolmentResponse,
  BiometricEnrolmentsResponse,
  EnrolBiometricRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import {
  deletionColumns,
  deletionViews,
  enrolmentColumns,
  enrolmentViews,
  type EnrolmentRow,
} from "./biometric-records.js";
import {
  approvedDpia,
  companySites,
  fromCalendarDate,
  latestFor,
  latestSwitches,
} from "./biometrics-store.js";
import { biometricsProblem, BiometricsPlatform, gateRefusal } from "./biometrics-support.js";
import { deleteEnrolment } from "./enrolment-deletion.js";

const READERS: readonly Permission[] = ["biometrics.manage", "biometrics.approve"];
/** The deletion log shows the latest entries; older ones stay in the database and the audit log. */
const DELETION_LOG_LIMIT = 200;

/**
 * Biometric enrolment (D3.4; DPIA_TEMPLATE §2.1, §7.1, decision D-168). A capture device sends a
 * worker's templates — never images — with an ID it chose, so a retry returns the same enrolment.
 * Enrolling needs `biometrics.enrol` on the site's project, biometric capture on for the site and
 * method today under the approved DPIA in force, a template key on this installation, an active
 * worker engaged on that project today, and the worker's consent for the modality to the current
 * notice. A new enrolment replaces the worker's previous one of the modality (deleted, logged).
 * Templates are sealed to the biometrics-only public key one by one, bound to their row; the
 * decoded bytes are wiped from memory afterwards. Deleting on the worker's request needs
 * `biometrics.manage`. The database repeats every rule.
 */
@Injectable()
export class BiometricEnrolmentService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly platform: BiometricsPlatform,
  ) {}

  enrol(
    principal: Principal,
    input: EnrolBiometricRequest,
    req: Request,
  ): Promise<BiometricEnrolmentResponse> {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const tenantId = access.tenantId;
        const existing = await tx.biometricEnrolment.findUnique({
          where: { tenantId_id: { tenantId, id: input.id } },
          select: enrolmentColumns,
        });
        if (existing) return this.replay(scope, existing, input);

        const site = (await companySites(tx, tenantId)).find((entry) => entry.id === input.siteId);
        if (!site) throw new NotFoundException("Site not found");
        await this.policy.require(scope, "biometrics.enrol", { projectId: site.projectId });
        if (!this.platform.isAvailable()) throw gateRefusal("platform_off");
        const sealer = this.platform.sealer;
        if (!sealer)
          throw biometricsProblem(
            409,
            "template-key-missing",
            "No biometric template key is configured on this installation",
          );
        const today = nairobiDate();
        const approved = await approvedDpia(tx, tenantId);
        const gate = biometricGate({
          platformAvailable: true,
          projectStatus: site.projectStatus,
          approved,
          latestSwitch: latestFor(
            await latestSwitches(tx, tenantId, site.id),
            site.id,
            input.method,
          ),
          siteId: site.id,
          method: input.method,
          today,
        });
        if (!gate.on)
          throw gate.reason === "switched_off"
            ? biometricsProblem(
                409,
                "biometrics-unavailable",
                "Biometric capture is switched off for this site and method",
              )
            : gateRefusal(gate.reason);

        const labourer = await tx.labourer.findUnique({
          where: { tenantId_id: { tenantId, id: input.labourerId } },
          select: { id: true, status: true },
        });
        if (!labourer) throw new NotFoundException("Labourer not found");
        if (labourer.status !== "active")
          throw biometricsProblem(
            409,
            "labourer-inactive",
            "Only an active worker can be enrolled",
          );
        const day = fromCalendarDate(today);
        const engaged = await tx.labourEngagement.findFirst({
          where: {
            tenantId,
            labourerId: labourer.id,
            projectId: site.projectId,
            startDate: { lte: day },
            OR: [{ endDate: null }, { endDate: { gte: day } }],
          },
          select: { id: true },
        });
        if (!engaged)
          throw biometricsProblem(
            409,
            "not-engaged",
            "The worker is not engaged on this site's project today",
          );
        const kind = BIOMETRIC_CONSENT_KINDS[input.modality];
        const consent = await tx.labourerConsent.findFirst({
          where: {
            tenantId,
            labourerId: labourer.id,
            kind,
            granted: true,
            withdrawnAt: null,
            noticeVersion: currentConsentNotice(kind).version,
          },
          orderBy: { capturedAt: "desc" },
          select: { id: true },
        });
        if (!consent)
          throw biometricsProblem(
            409,
            "consent-required",
            "Record the worker's consent to the current notice for this modality first",
          );

        const templates = input.templates.map((template) => Buffer.from(template.data, "base64"));
        try {
          if (templates.some((bytes) => looksLikeImage(bytes)))
            throw biometricsProblem(
              422,
              "raw-image-refused",
              "Send templates only: images are never stored or uploaded",
            );
          const previous = await tx.biometricEnrolment.findFirst({
            where: {
              tenantId,
              labourerId: labourer.id,
              modality: input.modality,
              status: "active",
            },
            select: { id: true },
          });
          if (previous) await deleteEnrolment(tx, this.scope, tenantId, previous.id, "re_enrolled");
          const [first] = input.templates;
          await tx.biometricEnrolment.create({
            data: {
              id: input.id,
              tenantId,
              labourerId: labourer.id,
              modality: input.modality,
              captureMethod: input.method,
              consentId: consent.id,
              dpiaRecordId: approved!.id,
              projectId: site.projectId,
              siteId: site.id,
              templateCount: templates.length,
              algorithm: first!.algorithm,
              algorithmVersion: first!.algorithmVersion,
              enrolledBy: access.userId,
            },
            select: { id: true },
          });
          // No RETURNING: the runtime role cannot read template_enc back.
          await tx.biometricTemplate.createMany({
            data: templates.map((bytes, index) => {
              const id = randomUUID();
              return {
                id,
                tenantId,
                enrolmentId: input.id,
                ordinal: index + 1,
                templateEnc: sealer.seal({ tenantId, templateId: id }, bytes),
                qualityScore: input.templates[index]!.qualityScore,
                keyVersion: sealer.activeVersion,
              };
            }),
          });
          await this.scope.audit(tx, "biometrics.enrolled", input.id, {
            labourerId: labourer.id,
            modality: input.modality,
            method: input.method,
            siteId: site.id,
            templates: templates.length,
            keyVersion: sealer.activeVersion,
            replaced: previous?.id ?? null,
          });
          return {
            enrolment: await this.one(scope, input.id),
            replaced: previous?.id ?? null,
          };
        } finally {
          for (const bytes of templates) bytes.fill(0);
        }
      },
      true,
    );
  }

  /** Deletes an enrolment's templates on the worker's request (a data subject request). */
  deleteOnRequest(
    principal: Principal,
    enrolmentId: string,
    req: Request,
  ): Promise<BiometricEnrolmentResponse> {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.require(scope, "biometrics.manage");
        const { tx, access } = scope;
        const row = await tx.biometricEnrolment.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: enrolmentId } },
          select: { modality: true },
        });
        if (!row) throw new NotFoundException("Enrolment not found");
        const templates = await deleteEnrolment(
          tx,
          this.scope,
          access.tenantId,
          enrolmentId,
          "request",
        );
        if (templates === null)
          throw biometricsProblem(409, "enrolment-deleted", "These templates were already deleted");
        await this.scope.audit(tx, "biometrics.enrolment_deleted", enrolmentId, {
          modality: row.modality,
          reason: "request",
          templates,
        });
        return { enrolment: await this.one(scope, enrolmentId), replaced: null };
      },
      true,
    );
  }

  /** Every enrolment still holding templates (active, held or due for deletion). */
  list(principal: Principal, req: Request): Promise<BiometricEnrolmentsResponse> {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.requireAny(scope, READERS);
      const { tx, access } = scope;
      const today = nairobiDate();
      const rows = await tx.biometricEnrolment.findMany({
        where: { tenantId: access.tenantId, status: "active" },
        select: enrolmentColumns,
        orderBy: [{ enrolledAt: "desc" }, { id: "asc" }],
      });
      return {
        today,
        retention: {
          daysAfterEngagement: this.platform.retentionDays,
          jobEnabled: this.platform.retentionJobEnabled,
        },
        enrolments: await enrolmentViews(tx, access.tenantId, rows, {
          today,
          retentionDays: this.platform.retentionDays,
          approved: await approvedDpia(tx, access.tenantId),
        }),
        permissions: { canManageTemplates: access.permissions.has("biometrics.manage") },
      };
    });
  }

  /** The deletion log, newest first. */
  deletions(principal: Principal, req: Request): Promise<BiometricDeletionsResponse> {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.requireAny(scope, READERS);
      const { tx, access } = scope;
      const rows = await tx.biometricDeletion.findMany({
        where: { tenantId: access.tenantId },
        select: deletionColumns,
        orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
        take: DELETION_LOG_LIMIT,
      });
      return { deletions: await deletionViews(tx, access.tenantId, rows) };
    });
  }

  /**
   * A retry of an enrolment this company already has: the same worker, modality, site and method
   * get it back (whatever has happened to it since); anything else reusing the ID is refused.
   */
  private async replay(
    scope: Scope,
    existing: EnrolmentRow,
    input: EnrolBiometricRequest,
  ): Promise<BiometricEnrolmentResponse> {
    await this.policy.require(scope, "biometrics.enrol", { projectId: existing.projectId });
    if (
      existing.labourerId !== input.labourerId ||
      existing.modality !== input.modality ||
      existing.siteId !== input.siteId ||
      existing.captureMethod !== input.method
    )
      throw biometricsProblem(
        409,
        "enrolment-conflict",
        "This enrolment ID was already used for another enrolment",
      );
    return { enrolment: await this.one(scope, existing.id), replaced: null };
  }

  private async one(scope: Scope, enrolmentId: string) {
    const { tx, access } = scope;
    const row = await tx.biometricEnrolment.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: access.tenantId, id: enrolmentId } },
      select: enrolmentColumns,
    });
    const [view] = await enrolmentViews(tx, access.tenantId, [row], {
      today: nairobiDate(),
      retentionDays: this.platform.retentionDays,
      approved: await approvedDpia(tx, access.tenantId),
    });
    return view!;
  }
}
