import { ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  biometricConsentStatus,
  coversModality,
  nairobiDate,
  smsCompanyName,
  type ApprovedDpia,
} from "@pm-buddy/domain";
import { messages } from "@pm-buddy/i18n";
import {
  BIOMETRIC_CONSENT_KINDS,
  BIOMETRIC_MODALITIES,
  currentConsentNotice,
  type BiometricModality,
  type ConsentMethod,
  type ConsentNoticeVersion,
  type LabourerStatus,
  type Locale,
  type Permission,
} from "@pm-buddy/types";
import type {
  BiometricConsentBlock,
  RecordBiometricConsentRequest,
  WithdrawBiometricConsentRequest,
  WorkerBiometricsResponse,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { Scope } from "../identity/access-policy.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { LabourAccess, LabourCrypto } from "../labour/labour-support.js";
import {
  deletionColumns,
  deletionViews,
  enrolmentColumns,
  enrolmentViews,
} from "./biometric-records.js";
import { approvedDpia, peopleOf } from "./biometrics-store.js";
import { biometricsProblem, BiometricsPlatform, gateRefusal } from "./biometrics-support.js";
import { journal } from "./biometric-journal.js";
import { deleteEnrolments } from "./enrolment-deletion.js";

const KINDS = Object.values(BIOMETRIC_CONSENT_KINDS);
/** DPIA §7.1: withdrawal goes through a supervisor, the site agent or the DPO's office. */
const WITHDRAWERS: readonly Permission[] = ["biometrics.enrol", "labour.consent"];

type Worker = {
  row: {
    id: string;
    workerNo: string;
    fullName: string;
    status: string;
    phoneEnc: Uint8Array | null;
  };
  effective: ReadonlySet<Permission>;
};
type Sms = { to: string; text: string } | null;

/**
 * Biometric consent per modality (D3.4; DPIA_TEMPLATE §7, decision D-166). A worker answers the
 * notice of one modality — face or fingerprint — in the language they choose, signed or read aloud
 * with a witness: yes, or no (recorded with no reason asked; the card fallback is unaffected).
 * Consent is recorded by a `biometrics.enrol` holder on the worker's projects, only while the
 * platform allows biometrics and the approved DPIA in force covers the modality; the record names
 * that DPIA (its DPO and phone were in the notice). Withdrawal is never blocked: any holder of
 * `biometrics.enrol` or `labour.consent` on the worker, or `biometrics.manage`, records it, and
 * the modality's templates are deleted in the same transaction. Each decision is confirmed to the
 * worker by SMS in their language after it commits.
 */
@Injectable()
export class BiometricConsentService {
  private readonly logger = new Logger(BiometricConsentService.name);

  constructor(
    private readonly scope: TenantScope,
    private readonly labour: LabourAccess,
    private readonly crypto: LabourCrypto,
    private readonly platform: BiometricsPlatform,
    private readonly security: AuthSecurity,
  ) {}

  worker(principal: Principal, labourerId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const worker = await this.load(scope, labourerId);
      return this.view(scope, worker);
    });
  }

  async record(
    principal: Principal,
    labourerId: string,
    input: RecordBiometricConsentRequest,
    req: Request,
  ): Promise<WorkerBiometricsResponse> {
    const { response, sms } = await this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const worker = await this.load(scope, labourerId);
        if (!worker.effective.has("biometrics.enrol"))
          throw new ForbiddenException("Permission required: biometrics.enrol");
        const today = nairobiDate();
        const approved = await approvedDpia(tx, access.tenantId);
        const blocked = this.blocked(input.modality, approved, today);
        if (blocked) throw gateRefusal(blocked);
        const kind = BIOMETRIC_CONSENT_KINDS[input.modality];
        const notice = currentConsentNotice(kind);
        if (input.noticeVersion !== notice.version)
          throw biometricsProblem(
            400,
            "notice-not-current",
            "Show the current notice for this modality.",
          );
        const active = await tx.labourerConsent.findMany({
          where: { tenantId: access.tenantId, labourerId, kind, granted: true, withdrawnAt: null },
          select: { noticeVersion: true },
        });
        if (input.granted && active.some((consent) => consent.noticeVersion === notice.version))
          throw biometricsProblem(
            409,
            "consent-recorded",
            "The worker's consent to this notice is already recorded.",
          );
        if (!input.granted && active.length)
          throw biometricsProblem(
            409,
            "consent-recorded",
            "The worker has agreed: record a withdrawal instead of a refusal.",
          );
        const consent = await tx.labourerConsent.create({
          data: {
            tenantId: access.tenantId,
            labourerId,
            kind,
            noticeVersion: notice.version,
            noticeDigest: notice.digests[input.language],
            language: input.language,
            method: input.method,
            witnessName: input.witnessName ?? null,
            granted: input.granted,
            capturedBy: access.userId,
            dpiaRecordId: approved!.id,
          },
          select: { id: true },
        });
        await this.scope.audit(tx, "biometrics.consent_recorded", labourerId, {
          consentId: consent.id,
          modality: input.modality,
          granted: input.granted,
          noticeVersion: notice.version,
          language: input.language,
          method: input.method,
        });
        return {
          response: await this.view(scope, worker),
          sms: await this.sms(
            scope,
            worker,
            input.language,
            input.granted ? "granted" : "refused",
            input.modality,
            approved!.id,
          ),
        };
      },
      true,
    );
    this.send(sms);
    return response;
  }

  async withdraw(
    principal: Principal,
    labourerId: string,
    input: WithdrawBiometricConsentRequest,
    req: Request,
  ): Promise<WorkerBiometricsResponse> {
    const { response, sms } = await this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const worker = await this.load(scope, labourerId);
        if (
          !WITHDRAWERS.some((permission) => worker.effective.has(permission)) &&
          !access.permissions.has("biometrics.manage")
        )
          throw new ForbiddenException(
            "One of these permissions is required: biometrics.enrol, labour.consent, biometrics.manage",
          );
        const kind = BIOMETRIC_CONSENT_KINDS[input.modality];
        const active = await tx.labourerConsent.findMany({
          where: { tenantId: access.tenantId, labourerId, kind, granted: true, withdrawnAt: null },
          select: { id: true, language: true, dpiaRecordId: true },
          orderBy: { capturedAt: "desc" },
        });
        if (!active.length)
          throw biometricsProblem(
            409,
            "consent-not-granted",
            "There is no consent for this modality to withdraw.",
          );
        for (const consent of active)
          await tx.labourerConsent.update({
            where: { tenantId_id: { tenantId: access.tenantId, id: consent.id } },
            data: {
              withdrawnAt: new Date(),
              withdrawnBy: access.userId,
              withdrawalMethod: input.method,
              withdrawalWitness: input.witnessName ?? null,
            },
            select: { id: true },
          });
        journal(
          this.scope,
          `Biometric consent withdrawn: company ${access.tenantId}, labourer ${labourerId}, ${input.modality}`,
        );
        const deleted = await deleteEnrolments(
          tx,
          this.scope,
          access.tenantId,
          { labourerId, modalities: [input.modality] },
          "consent_withdrawn",
        );
        await this.scope.audit(tx, "biometrics.consent_withdrawn", labourerId, {
          modality: input.modality,
          consents: active.length,
          method: input.method,
          enrolmentsDeleted: deleted.enrolments,
          templatesDeleted: deleted.templates,
        });
        const latest = active[0]!;
        return {
          response: await this.view(scope, worker),
          sms: await this.sms(
            scope,
            worker,
            latest.language as Locale,
            "withdrawn",
            input.modality,
            latest.dpiaRecordId,
          ),
        };
      },
      true,
    );
    this.send(sms);
    return response;
  }

  /**
   * The worker, if the caller may see them: `labour.view` on one of their projects, or
   * `biometrics.manage` (the company's DPO handling a request). 404 otherwise.
   */
  private async load(scope: Scope, labourerId: string): Promise<Worker> {
    const { tx, access } = scope;
    const row = await tx.labourer.findUnique({
      where: { tenantId_id: { tenantId: access.tenantId, id: labourerId } },
      select: { id: true, workerNo: true, fullName: true, status: true, phoneEnc: true },
    });
    if (!row) throw new NotFoundException("Labourer not found");
    const engagements = await tx.labourEngagement.findMany({
      where: { tenantId: access.tenantId, labourerId },
      select: { projectId: true },
    });
    const effective = await this.labour.effectiveOn(scope, [
      ...new Set(engagements.map((engagement) => engagement.projectId)),
    ]);
    if (!effective.has("labour.view") && !access.permissions.has("biometrics.manage"))
      throw new NotFoundException("Labourer not found");
    return { row, effective };
  }

  /** Why consent for a modality cannot be recorded now (null: it can). */
  private blocked(
    modality: BiometricModality,
    approved: ApprovedDpia | null,
    today: string,
  ): BiometricConsentBlock | null {
    if (!this.platform.isAvailable()) return "platform_off";
    if (!approved) return "no_dpia";
    if (approved.reviewDue < today) return "dpia_lapsed";
    if (!coversModality(approved.methods, modality)) return "not_in_scope";
    return null;
  }

  private async view(scope: Scope, worker: Worker): Promise<WorkerBiometricsResponse> {
    const { tx, access } = scope;
    const tenantId = access.tenantId;
    const today = nairobiDate();
    const approved = await approvedDpia(tx, tenantId);
    const dpia = approved
      ? await tx.dpiaRecord.findUniqueOrThrow({
          where: { tenantId_id: { tenantId, id: approved.id } },
          select: { versionNo: true, dpoName: true, dpoPhone: true },
        })
      : null;
    const company = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    const consents = await tx.labourerConsent.findMany({
      where: { tenantId, labourerId: worker.row.id, kind: { in: KINDS } },
      orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
    });
    const versionOf = new Map(
      (
        await tx.dpiaRecord.findMany({
          where: {
            tenantId,
            id: { in: [...new Set(consents.map((consent) => consent.dpiaRecordId!))] },
          },
          select: { id: true, versionNo: true },
        })
      ).map((record) => [record.id, record.versionNo]),
    );
    const enrolments = await enrolmentViews(
      tx,
      tenantId,
      await tx.biometricEnrolment.findMany({
        where: { tenantId, labourerId: worker.row.id, status: "active" },
        select: enrolmentColumns,
      }),
      { today, retentionDays: this.platform.retentionDays, approved },
    );
    const deletions = await deletionViews(
      tx,
      tenantId,
      await tx.biometricDeletion.findMany({
        where: { tenantId, labourerId: worker.row.id },
        select: deletionColumns,
        orderBy: { deletedAt: "desc" },
      }),
    );
    const people = await peopleOf(
      tx,
      consents.flatMap((consent) => [consent.capturedBy, consent.withdrawnBy]),
    );
    const person = (id: string) => ({ id, displayName: people.get(id) ?? "—" });
    const canWithdraw =
      WITHDRAWERS.some((permission) => worker.effective.has(permission)) ||
      access.permissions.has("biometrics.manage");
    return {
      today,
      platformAvailable: this.platform.isAvailable(),
      retention: {
        daysAfterEngagement: this.platform.retentionDays,
        jobEnabled: this.platform.retentionJobEnabled,
      },
      labourer: {
        id: worker.row.id,
        workerNo: worker.row.workerNo,
        fullName: worker.row.fullName,
        status: worker.row.status as LabourerStatus,
      },
      company,
      dpia:
        approved && dpia
          ? {
              id: approved.id,
              versionNo: dpia.versionNo,
              state: approved.reviewDue >= today ? "in_force" : "lapsed",
              methods: [...approved.methods],
              dpoName: dpia.dpoName,
              dpoPhone: dpia.dpoPhone,
            }
          : null,
      modalities: BIOMETRIC_MODALITIES.map((modality) => {
        const kind = BIOMETRIC_CONSENT_KINDS[modality];
        const notice = currentConsentNotice(kind);
        const decisions = consents.filter((consent) => consent.kind === kind);
        return {
          modality,
          blocked: this.blocked(modality, approved, today),
          noticeVersion: notice.version,
          consent: biometricConsentStatus(
            decisions.map((consent) => ({
              granted: consent.granted,
              noticeVersion: consent.noticeVersion,
              capturedAt: consent.capturedAt.toISOString(),
              withdrawnAt: consent.withdrawnAt?.toISOString() ?? null,
            })),
            notice.version,
          ),
          enrolment: enrolments.find((enrolment) => enrolment.modality === modality) ?? null,
          decisions: decisions.map((consent) => ({
            id: consent.id,
            granted: consent.granted,
            noticeVersion: consent.noticeVersion as ConsentNoticeVersion,
            language: consent.language as Locale,
            method: consent.method as ConsentMethod,
            witnessName: consent.witnessName,
            capturedAt: consent.capturedAt.toISOString(),
            capturedBy: person(consent.capturedBy),
            dpiaVersionNo: versionOf.get(consent.dpiaRecordId!) ?? 1,
            withdrawnAt: consent.withdrawnAt?.toISOString() ?? null,
            withdrawnBy: consent.withdrawnBy ? person(consent.withdrawnBy) : null,
            withdrawalMethod: (consent.withdrawalMethod ?? null) as ConsentMethod | null,
          })),
          deletions: deletions.filter((deletion) => deletion.modality === modality),
        };
      }),
      permissions: {
        canConsent: worker.effective.has("biometrics.enrol"),
        canWithdraw,
        canDelete: access.permissions.has("biometrics.manage"),
      },
    };
  }

  /**
   * The confirmation SMS (DPIA §7.4) to the worker's own phone, in their language, naming the DPO's
   * phone from the DPIA the decision was recorded under. Null when no phone is registered.
   */
  private async sms(
    scope: Scope,
    worker: Worker,
    language: Locale,
    decision: "granted" | "refused" | "withdrawn",
    modality: BiometricModality,
    dpiaRecordId: string | null,
  ): Promise<Sms> {
    if (!worker.row.phoneEnc) return null;
    const { tx, access } = scope;
    const dpia = dpiaRecordId
      ? await tx.dpiaRecord.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: dpiaRecordId } },
          select: { dpoPhone: true },
        })
      : null;
    const company = await tx.tenant.findUniqueOrThrow({
      where: { id: access.tenantId },
      select: { name: true },
    });
    const t = messages(language).biometrics.sms;
    const [year, month, day] = nairobiDate().split("-");
    const text = t[decision]
      .replace("{company}", smsCompanyName(company.name))
      .replace("{date}", `${day}/${month}/${year}`)
      .replace("{modality}", t.modalities[modality])
      .replace("{dpoPhone}", dpia?.dpoPhone ?? "—");
    return {
      to: this.crypto.open(access.tenantId, worker.row.id, "phone_enc", worker.row.phoneEnc),
      text,
    };
  }

  /** After the commit: never delays or fails the request; failures are logged without content. */
  private send(sms: Sms) {
    if (!sms) return;
    this.security.notifyLater(sms.to, "Biometric consent", sms.text, "sms");
    this.logger.debug("Biometric consent confirmation queued");
  }
}
