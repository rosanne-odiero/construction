import { createHash } from "node:crypto";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  carriedForwardSwitches,
  coversModality,
  documentFileName,
  dpiaApprovalContent,
  dpiaApprovalGaps,
  isDpiaReviewDueValid,
  nairobiDate,
} from "@pm-buddy/domain";
import {
  BIOMETRIC_MODALITIES,
  DOCUMENT_LIMITS,
  DPIA_GO_LIVE_CONDITIONS,
  type BiometricCaptureMethod,
  type Permission,
} from "@pm-buddy/types";
import type {
  ApproveDpiaRequest,
  CreateDpiaRequest,
  DpiaResponse,
  RejectDpiaRequest,
  UpdateDpiaRequest,
  WithdrawDpiaRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { describeError } from "../../common/errors.js";
import { uuidv7 } from "../../common/uuid.js";
import { MalwareDetected, MalwareScanner, type ScanResult } from "../../infra/malware-scanner.js";
import { StorageService } from "../../infra/storage.service.js";
import { canonicalJson, sha256 } from "../attendance/attendance-support.js";
import {
  DocumentRefused,
  inspectDocument,
  type UploadedDocumentFile,
} from "../documents/document-files.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import {
  companySites,
  detailOf,
  draftFacts,
  fromCalendarDate,
  latestSwitches,
  peopleOf,
  recordColumns,
  recordPeople,
  scopeOf,
  switchCandidates,
  type RecordRow,
} from "./biometrics-store.js";
import { biometricsProblem, versionConflict } from "./biometrics-support.js";
import { journal } from "./biometric-journal.js";
import { deleteEnrolments } from "./enrolment-deletion.js";

const READERS: readonly Permission[] = ["biometrics.manage", "biometrics.approve"];

const objectKey = (tenantId: string, dpiaRecordId: string, documentId: string) =>
  `tenants/${tenantId}/dpias/${dpiaRecordId}/${documentId}`;

type Prepared = {
  buffer: Buffer;
  fileName: string;
  sha256: string;
  scan: ScanResult;
};

/** The fields a draft records, as stored. */
function draftData(input: CreateDpiaRequest) {
  return {
    captureMethods: [...input.methods],
    dpoName: input.dpoName,
    dpoPhone: input.dpoPhone,
    dpoOpinion: input.dpoOpinion,
    dpoOpinionOn: input.dpoOpinionOn ? fromCalendarDate(input.dpoOpinionOn) : null,
    dpoNote: input.dpoNote,
    controllerName: input.controllerName,
    controllerRole: input.controllerRole,
    controllerDecision: input.controllerDecision,
    controllerDecisionOn: input.controllerDecisionOn
      ? fromCalendarDate(input.controllerDecisionOn)
      : null,
    controllerNote: input.controllerNote,
    residualRisk: input.residualRisk,
    odpcReference: input.odpcReference,
  };
}

/**
 * The company's DPIA for biometric attendance (D3.4, DPIA_TEMPLATE §12.4): drafts, the signed
 * document, and approval, rejection or withdrawal by a `biometrics.approve` holder with a fresh
 * step-up. One person may prepare and approve (owner decision, 15 November 2026). Approving a
 * renewal supersedes the approved version and carries its switches forward where still covered;
 * templates of a modality it no longer covers are deleted, and withdrawing deletes them all
 * (owner decision, 16 November 2026). A lapse deletes nothing: the templates are held, unused.
 * Audit metadata carries IDs, codes, counts and hashes only: never names, notes or reasons.
 */
@Injectable()
export class DpiaService {
  private readonly logger = new Logger(DpiaService.name);

  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly storage: StorageService,
    private readonly scanner: MalwareScanner,
  ) {}

  async get(principal: Principal, dpiaId: string, req: Request): Promise<DpiaResponse> {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.requireAny(scope, READERS);
      return { dpia: await this.detail(scope, dpiaId) };
    });
  }

  async create(
    principal: Principal,
    input: CreateDpiaRequest,
    req: Request,
  ): Promise<DpiaResponse> {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.require(scope, "biometrics.manage");
        const { tx, access } = scope;
        if (await tx.dpiaRecord.count({ where: { tenantId: access.tenantId, status: "draft" } }))
          throw biometricsProblem(
            409,
            "dpia-draft-exists",
            "A draft DPIA already exists: finish or close it first",
          );
        await this.checkSites(scope, input.siteIds);
        const latest = await tx.dpiaRecord.aggregate({
          where: { tenantId: access.tenantId },
          _max: { versionNo: true },
        });
        const record = await tx.dpiaRecord.create({
          data: {
            tenantId: access.tenantId,
            versionNo: (latest._max.versionNo ?? 0) + 1,
            ...draftData(input),
            createdBy: access.userId,
            updatedBy: access.userId,
          },
          select: { id: true, versionNo: true },
        });
        if (input.siteIds.length)
          await tx.dpiaRecordSite.createMany({
            data: input.siteIds.map((siteId) => ({
              tenantId: access.tenantId,
              dpiaRecordId: record.id,
              siteId,
            })),
          });
        await this.scope.audit(tx, "dpia.created", record.id, {
          versionNo: record.versionNo,
          methods: input.methods,
          siteCount: input.siteIds.length,
        });
        return { dpia: await this.detail(scope, record.id) };
      },
      true,
    );
  }

  async update(
    principal: Principal,
    dpiaId: string,
    input: UpdateDpiaRequest,
    req: Request,
  ): Promise<DpiaResponse> {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.require(scope, "biometrics.manage");
        const { tx, access } = scope;
        const row = await this.draftRow(scope, dpiaId, input.version);
        await this.checkSites(scope, input.siteIds);
        const data = draftData(input);
        const changed = await tx.dpiaRecord.updateMany({
          where: { tenantId: access.tenantId, id: dpiaId, version: input.version, status: "draft" },
          data: { ...data, version: { increment: 1 }, updatedBy: access.userId },
        });
        if (changed.count !== 1) throw versionConflict();
        const before = await scopeOf(tx, access.tenantId, dpiaId);
        const removed = before.filter((siteId) => !input.siteIds.includes(siteId));
        const added = input.siteIds.filter((siteId) => !before.includes(siteId));
        if (removed.length)
          await tx.dpiaRecordSite.deleteMany({
            where: { tenantId: access.tenantId, dpiaRecordId: dpiaId, siteId: { in: removed } },
          });
        if (added.length)
          await tx.dpiaRecordSite.createMany({
            data: added.map((siteId) => ({
              tenantId: access.tenantId,
              dpiaRecordId: dpiaId,
              siteId,
            })),
          });
        const fields = (Object.keys(data) as (keyof typeof data)[]).filter(
          (key) => JSON.stringify(data[key]) !== JSON.stringify(row[key]),
        );
        await this.scope.audit(tx, "dpia.updated", dpiaId, {
          versionNo: row.versionNo,
          fields: [...fields, ...(removed.length || added.length ? ["siteIds"] : [])],
        });
        return { dpia: await this.detail(scope, dpiaId) };
      },
      true,
    );
  }

  /** The signed DPIA (PDF only) for a draft; it replaces any earlier upload. */
  async upload(
    principal: Principal,
    dpiaId: string,
    file: UploadedDocumentFile | undefined,
    req: Request,
  ): Promise<DpiaResponse> {
    // Permission and state first, so a refused caller never gets a file scanned or stored.
    await this.scope.run(principal, req, async (scope) => {
      await this.policy.require(scope, "biometrics.manage");
      await this.draftRow(scope, dpiaId);
    });
    const prepared = await this.prepare(file);
    const tenantId = principal.session.activeTenantId!;
    const documentId = uuidv7();
    const key = objectKey(tenantId, dpiaId, documentId);
    await this.storage.put(key, prepared.buffer, "application/pdf", prepared.sha256);
    try {
      return await this.scope.run(
        principal,
        req,
        async (scope) => {
          await this.policy.require(scope, "biometrics.manage");
          const { tx, access } = scope;
          const row = await this.draftRow(scope, dpiaId);
          await tx.dpiaDocument.create({
            data: {
              id: documentId,
              tenantId: access.tenantId,
              dpiaRecordId: dpiaId,
              fileName: prepared.fileName,
              contentType: "application/pdf",
              sizeBytes: prepared.buffer.length,
              sha256: prepared.sha256,
              objectKey: key,
              scanStatus: prepared.scan.status,
              scanEngine: prepared.scan.engine,
              scannedAt: prepared.scan.scannedAt,
              uploadedBy: access.userId,
            },
          });
          const changed = await tx.dpiaRecord.updateMany({
            where: { tenantId: access.tenantId, id: dpiaId, version: row.version, status: "draft" },
            data: { documentId, version: { increment: 1 }, updatedBy: access.userId },
          });
          if (changed.count !== 1) throw versionConflict();
          await this.scope.audit(tx, "dpia.document_uploaded", dpiaId, {
            versionNo: row.versionNo,
            documentId,
            sha256: prepared.sha256,
            sizeBytes: prepared.buffer.length,
            replaced: row.documentId !== null,
          });
          return { dpia: await this.detail(scope, dpiaId) };
        },
        true,
      );
    } catch (error) {
      await this.storage
        .delete(key)
        .catch((cleanup: unknown) =>
          this.logger.warn(`Could not remove an orphaned upload: ${describeError(cleanup)}`),
        );
      throw error;
    }
  }

  /** The record's current signed document, after the read checks; audited and hash-verified. */
  async download(principal: Principal, dpiaId: string, req: Request) {
    const document = await this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.requireAny(scope, READERS);
        const { tx, access } = scope;
        const row = await this.row(scope, dpiaId);
        if (!row.documentId) throw new NotFoundException("This DPIA has no signed document yet");
        const found = await tx.dpiaDocument.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: row.documentId } },
          select: { id: true, fileName: true, sha256: true, objectKey: true },
        });
        await this.scope.audit(tx, "dpia.document_downloaded", dpiaId, {
          versionNo: row.versionNo,
          documentId: found.id,
        });
        return found;
      },
      true,
    );
    const content = await this.storage.get(document.objectKey, DOCUMENT_LIMITS.maxFileBytes);
    if (createHash("sha256").update(content).digest("hex") !== document.sha256)
      throw biometricsProblem(409, "file-integrity", "The stored file does not match its checksum");
    return { content, fileName: document.fileName };
  }

  async approve(
    principal: Principal,
    dpiaId: string,
    input: ApproveDpiaRequest,
    req: Request,
  ): Promise<DpiaResponse> {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.require(scope, "biometrics.approve", { stepUp: true });
        const { tx, access } = scope;
        const row = await this.draftRow(scope, dpiaId, input.version);
        const today = nairobiDate();
        const siteIds = await scopeOf(tx, access.tenantId, dpiaId);
        if (dpiaApprovalGaps(draftFacts(row, siteIds.length), today).length)
          throw biometricsProblem(
            422,
            "dpia-incomplete",
            "The DPIA is not complete enough to approve",
          );
        const document = await tx.dpiaDocument.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: row.documentId! } },
          select: { sha256: true },
        });
        if (document.sha256 !== input.documentSha256)
          throw biometricsProblem(
            409,
            "document-changed",
            "The signed document changed since you opened it. Review the new file.",
          );
        if (!isDpiaReviewDueValid(input.reviewDue, today))
          throw biometricsProblem(
            422,
            "review-date-invalid",
            "The review date must be after today and at most 12 months ahead",
          );
        if (DPIA_GO_LIVE_CONDITIONS.some((condition) => !input.confirmations.includes(condition)))
          throw biometricsProblem(
            422,
            "conditions-unconfirmed",
            "Confirm every condition before go-live",
          );
        const facts = draftFacts(row, siteIds.length);
        const digest = sha256(
          canonicalJson(
            dpiaApprovalContent({
              ...facts,
              versionNo: row.versionNo,
              siteIds,
              controllerRole: row.controllerRole,
              documentSha256: document.sha256,
              reviewDue: input.reviewDue,
              conditions: DPIA_GO_LIVE_CONDITIONS,
            }),
          ),
        );

        // The approved version (in force or lapsed) is superseded first: one approved at a time.
        const previous = await tx.dpiaRecord.findFirst({
          where: { tenantId: access.tenantId, status: "approved" },
          select: { id: true, versionNo: true },
        });
        let carried: { siteId: string; method: BiometricCaptureMethod; projectId: string }[] = [];
        if (previous) {
          const sites = await companySites(tx, access.tenantId);
          const candidates = switchCandidates(await latestSwitches(tx, access.tenantId), sites);
          const project = new Map(candidates.map((entry) => [entry.siteId, entry.projectId]));
          carried = carriedForwardSwitches(candidates, previous.id, {
            methods: row.captureMethods as BiometricCaptureMethod[],
            siteIds,
          }).map((entry) => ({ ...entry, projectId: project.get(entry.siteId)! }));
          await tx.dpiaRecord.update({
            where: { tenantId_id: { tenantId: access.tenantId, id: previous.id } },
            data: {
              status: "superseded",
              supersededById: dpiaId,
              version: { increment: 1 },
              updatedBy: access.userId,
            },
          });
        }
        const changed = await tx.dpiaRecord.updateMany({
          where: { tenantId: access.tenantId, id: dpiaId, version: input.version, status: "draft" },
          data: {
            status: "approved",
            approvedBy: access.userId,
            reviewDue: fromCalendarDate(input.reviewDue),
            conditionsConfirmed: [...DPIA_GO_LIVE_CONDITIONS],
            approvedDigest: digest,
            version: { increment: 1 },
            updatedBy: access.userId,
          },
        });
        if (changed.count !== 1) throw versionConflict();
        // Templates of a modality the new version no longer covers are deleted now (D-170).
        const uncovered = BIOMETRIC_MODALITIES.filter(
          (modality) => !coversModality(row.captureMethods as BiometricCaptureMethod[], modality),
        );
        const outOfScope = uncovered.length
          ? await deleteEnrolments(
              tx,
              this.scope,
              access.tenantId,
              { modalities: uncovered },
              "out_of_scope",
            )
          : { enrolments: 0, templates: 0 };
        for (const entry of carried)
          await tx.biometricSwitch.create({
            data: {
              tenantId: access.tenantId,
              projectId: entry.projectId,
              siteId: entry.siteId,
              method: entry.method,
              enabled: true,
              dpiaRecordId: dpiaId,
              carriedForward: true,
              actorId: access.userId,
            },
          });
        await this.scope.audit(tx, "dpia.approved", dpiaId, {
          versionNo: row.versionNo,
          methods: row.captureMethods,
          siteCount: siteIds.length,
          reviewDue: input.reviewDue,
          documentSha256: document.sha256,
          digest,
          supersededVersionNo: previous?.versionNo ?? null,
          carriedForward: carried.length,
          enrolmentsDeleted: outOfScope.enrolments,
          templatesDeleted: outOfScope.templates,
        });
        return { dpia: await this.detail(scope, dpiaId) };
      },
      true,
    );
  }

  /** Closes a draft as not approved (the controller decided not to proceed). */
  async reject(
    principal: Principal,
    dpiaId: string,
    input: RejectDpiaRequest,
    req: Request,
  ): Promise<DpiaResponse> {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.require(scope, "biometrics.approve", { stepUp: true });
        const { tx, access } = scope;
        const row = await this.draftRow(scope, dpiaId, input.version);
        const changed = await tx.dpiaRecord.updateMany({
          where: { tenantId: access.tenantId, id: dpiaId, version: input.version, status: "draft" },
          data: {
            status: "rejected",
            rejectedBy: access.userId,
            rejectReason: input.reason,
            version: { increment: 1 },
            updatedBy: access.userId,
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(tx, "dpia.rejected", dpiaId, { versionNo: row.versionNo });
        return { dpia: await this.detail(scope, dpiaId) };
      },
      true,
    );
  }

  /**
   * Withdraws the approved DPIA: biometric capture stops on every site at once (fail closed) and
   * every enrolment's templates are deleted in the same transaction.
   */
  async withdraw(
    principal: Principal,
    dpiaId: string,
    input: WithdrawDpiaRequest,
    req: Request,
  ): Promise<DpiaResponse> {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.require(scope, "biometrics.approve", { stepUp: true });
        const { tx, access } = scope;
        const row = await this.row(scope, dpiaId);
        if (row.status !== "approved")
          throw biometricsProblem(409, "dpia-not-approved", "Only the approved DPIA is withdrawn");
        if (row.version !== input.version) throw versionConflict();
        const stopped = [...(await latestSwitches(tx, access.tenantId)).values()].filter(
          (entry) => entry.enabled && entry.dpiaRecordId === dpiaId,
        ).length;
        const changed = await tx.dpiaRecord.updateMany({
          where: {
            tenantId: access.tenantId,
            id: dpiaId,
            version: input.version,
            status: "approved",
          },
          data: {
            status: "withdrawn",
            withdrawnBy: access.userId,
            withdrawReason: input.reason,
            version: { increment: 1 },
            updatedBy: access.userId,
          },
        });
        if (changed.count !== 1) throw versionConflict();
        // Withdrawing ends the processing: every template is deleted now (D-170).
        journal(this.scope, `Biometric DPIA withdrawn: company ${access.tenantId}, DPIA ${dpiaId}`);
        const deleted = await deleteEnrolments(
          tx,
          this.scope,
          access.tenantId,
          {},
          "dpia_withdrawn",
        );
        await this.scope.audit(tx, "dpia.withdrawn", dpiaId, {
          versionNo: row.versionNo,
          switchesStopped: stopped,
          enrolmentsDeleted: deleted.enrolments,
          templatesDeleted: deleted.templates,
        });
        return { dpia: await this.detail(scope, dpiaId) };
      },
      true,
    );
  }

  private async row(scope: Scope, dpiaId: string): Promise<RecordRow> {
    const row = await scope.tx.dpiaRecord.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: dpiaId } },
      select: recordColumns,
    });
    if (!row) throw new NotFoundException("DPIA not found");
    return row;
  }

  /** A draft, at the version the caller saw when one is given. */
  private async draftRow(scope: Scope, dpiaId: string, version?: number): Promise<RecordRow> {
    const row = await this.row(scope, dpiaId);
    if (row.status !== "draft")
      throw biometricsProblem(409, "dpia-not-draft", "Only a draft DPIA can change");
    if (version !== undefined && row.version !== version) throw versionConflict();
    return row;
  }

  /** Every site must be one of the company's (RLS hides other companies' sites). */
  private async checkSites(scope: Scope, siteIds: readonly string[]): Promise<void> {
    if (!siteIds.length) return;
    const found = await scope.tx.site.count({
      where: { tenantId: scope.access.tenantId, id: { in: [...siteIds] } },
    });
    if (found !== siteIds.length)
      throw biometricsProblem(422, "unknown-site", "Choose sites of this company only");
  }

  private async detail(scope: Scope, dpiaId: string) {
    const { tx, access } = scope;
    const row = await this.row(scope, dpiaId);
    const today = nairobiDate();
    const siteIds = new Set(await scopeOf(tx, access.tenantId, dpiaId));
    const sites = (await companySites(tx, access.tenantId)).filter((site) => siteIds.has(site.id));
    const document = row.documentId
      ? await tx.dpiaDocument.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: row.documentId } },
          select: {
            id: true,
            fileName: true,
            sizeBytes: true,
            sha256: true,
            scanStatus: true,
            uploadedBy: true,
            uploadedAt: true,
          },
        })
      : null;
    const uploads = await tx.dpiaDocument.count({
      where: { tenantId: access.tenantId, dpiaRecordId: dpiaId },
    });
    const successor = row.supersededById
      ? await tx.dpiaRecord.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: row.supersededById } },
          select: { id: true, versionNo: true },
        })
      : null;
    const people = await peopleOf(tx, [...recordPeople(row), document?.uploadedBy]);
    return detailOf({
      row,
      sites,
      document,
      replacedDocuments: Math.max(0, uploads - (document ? 1 : 0)),
      successor,
      people,
      permissions: access.permissions,
      today,
    });
  }

  /** Content checks before anything is stored: a PDF by signature, size, SHA-256, malware hook. */
  private async prepare(file: UploadedDocumentFile | undefined): Promise<Prepared> {
    if (!file?.buffer?.length)
      throw biometricsProblem(400, "file-required", "Attach the signed DPIA as `file`");
    if (file.buffer.length > DOCUMENT_LIMITS.maxFileBytes)
      throw biometricsProblem(413, "payload-too-large", "Files may be at most 25 MB");
    let detected;
    try {
      detected = inspectDocument(file.buffer);
    } catch (error) {
      if (error instanceof DocumentRefused)
        throw biometricsProblem(
          error.code === "file-required" ? 400 : error.code === "unsupported-file-type" ? 415 : 422,
          error.code,
          error.message,
        );
      throw error;
    }
    if (detected.contentType !== "application/pdf")
      throw biometricsProblem(415, "pdf-required", "Upload the signed DPIA as a PDF");
    const hash = createHash("sha256").update(file.buffer).digest("hex");
    let scan: ScanResult;
    try {
      scan = await this.scanner.scan(file.buffer, { sha256: hash });
    } catch (error) {
      if (error instanceof MalwareDetected)
        throw biometricsProblem(
          422,
          "malware-detected",
          "The file was refused by the malware scanner",
        );
      throw error;
    }
    return {
      buffer: file.buffer,
      fileName: documentFileName(file.originalname ?? "", detected.extension),
      sha256: hash,
      scan,
    };
  }
}
