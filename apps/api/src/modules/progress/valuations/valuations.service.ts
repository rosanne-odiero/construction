import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import { measurementBasis, nairobiDate, valuationCode } from "@pm-buddy/domain";
import {
  CONTRACT_SETTINGS_PERMISSIONS,
  MEASUREMENT_APPROVE_PERMISSIONS,
  MEASUREMENT_READ_PERMISSIONS,
  MEASUREMENT_RECORD_PERMISSIONS,
  VALUATION_CERTIFY_PERMISSIONS,
  VALUATION_LIMITS,
  VALUATION_PREPARE_PERMISSIONS,
  VALUATION_READ_PERMISSIONS,
  type AdjustmentKind,
  type ReleaseStage,
  type RetentionStage,
  type ValuationKind,
  type ValuationStatus,
} from "@pm-buddy/types";
import {
  contractSettingsResponseSchema,
  projectValuationsResponseSchema,
  valuationResponseSchema,
  valuationsOverviewResponseSchema,
  type AddValuationAdjustmentRequest,
  type AddValuationMaterialRequest,
  type CreateValuationRequest,
  type UpdateContractSettingsRequest,
  type UpdateValuationRequest,
  type ValuationDetail,
  type ValuationSummary,
} from "@pm-buddy/validation";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import {
  minorOf,
  projectRef,
  SpendingAccess,
  trimDecimal,
  type ProjectAccess,
} from "../../finance/spending-common.js";
import { nextId } from "../../procurement/catalogue-store.js";
import { peopleOf, personOf, type People } from "../../procurement/procurement-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../../projects/project-mappers.js";
import {
  certifiedOf,
  clearedColumns,
  computeValuation,
  frozenColumns,
  lineRows,
  storedFigures,
  storedLines,
  storedTerms,
  storedToLines,
  type ComputedValuation,
  type ValuationRow,
} from "./valuation-calculator.js";
import {
  bqInForce,
  contractSumOf,
  invalidTransition,
  lockProject,
  makerChecker,
  measurable,
  settingsInForce,
  settingsWire,
  valuationConflict,
  valuationDatabaseProblem,
  valuationProblem,
  versionConflict,
} from "./valuation-common.js";

const SUBMIT_PROBLEMS: Record<NonNullable<ComputedValuation["problem"]>["code"], string> = {
  "bq-not-approved": "The project has no approved BQ yet",
  "no-certified-interim": "Retention is released only after an interim certificate",
  "nothing-to-release": "No retention is held",
  "release-exceeds-held": "This would release more retention than is held",
  "materials-exceed-remaining": "Materials on site for an item cannot exceed what remains of it",
  "recovery-exceeds-advance": "Advance recovery cannot exceed the advances certified",
  "valuation-date-invalid": "The valuation date is before the last certificate",
  "valuation-too-large": "This valuation has too many lines",
};

const toProblem = (problem: NonNullable<ComputedValuation["problem"]>) =>
  valuationConflict(
    problem.code,
    problem.code === "materials-exceed-remaining"
      ? `${SUBMIT_PROBLEMS[problem.code]} (${problem.ref})`
      : SUBMIT_PROBLEMS[problem.code],
  );

/**
 * Interim valuations, payment certificates and retention releases (D6.3 part A, brief §5.2 and
 * §15 C/G; WORKFLOWS "Valuations"; ARCHITECTURE §4.10). A `bq.edit` holder prepares a valuation
 * (date, materials on site, agreed adjustments) and submits it, which freezes its lines and
 * figures (rule KE-VAL-1) with a SHA-256 digest; a `finance.manage` holder who never contributed
 * certifies it with step-up, quoting the digest they saw, which numbers it IPC-NNNN. A certified
 * certificate never changes (database-enforced). Retention is released at certified practical
 * and final completion by release certificates in the same sequence.
 */
@Injectable()
export class ValuationsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SpendingAccess,
  ) {}

  private async reader(scope: Scope, projectId: string) {
    const project = await this.access.on(scope, projectId);
    if (!this.access.holds(project, VALUATION_READ_PERMISSIONS))
      throw new ForbiddenException("No permission to see valuations on this project");
    return project;
  }

  /** Projects where the caller measures or reads valuations, with their certificate position. */
  overview(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const ids = await this.access.projectIds(scope, [
        ...MEASUREMENT_READ_PERMISSIONS,
        ...VALUATION_READ_PERMISSIONS,
      ]);
      const rows = [];
      let approvalQueue = 0;
      for (const projectId of ids) {
        const project = await this.access.on(scope, projectId);
        const canReadValuations = this.access.holds(project, VALUATION_READ_PERMISSIONS);
        const canApprove = this.access.can(project, MEASUREMENT_APPROVE_PERMISSIONS);
        const pending = await tx.progressMeasurement.count({
          where: {
            tenantId: access.tenantId,
            projectId,
            review: { is: null },
            correctedBy: { is: null },
          },
        });
        if (canApprove)
          approvalQueue += await tx.progressMeasurement.count({
            where: {
              tenantId: access.tenantId,
              projectId,
              review: { is: null },
              correctedBy: { is: null },
              measuredBy: { not: access.userId },
            },
          });
        let position = {
          contractSum: null as Awaited<ReturnType<typeof contractSumOf>>,
          certifiedMinor: null as number | null,
          retentionHeldMinor: null as number | null,
          latestCertificate: null as {
            id: string;
            certificateNumber: string;
            valuationDate: string;
            amountDueMinor: number;
          } | null,
          openValuation: null as { id: string; number: string; status: ValuationStatus } | null,
        };
        if (canReadValuations) {
          const [contractSum, certified, open] = await Promise.all([
            contractSumOf(tx, access.tenantId, projectId),
            certifiedOf(tx, access.tenantId, projectId),
            tx.valuation.findFirst({
              where: {
                tenantId: access.tenantId,
                projectId,
                status: { in: ["draft", "submitted"] },
              },
            }),
          ]);
          const last = certified.at(-1);
          position = {
            contractSum,
            certifiedMinor: certified.reduce((sum, row) => sum + minorOf(row.amountDueMinor!), 0),
            retentionHeldMinor: last ? minorOf(last.retentionHeldMinor!) : 0,
            latestCertificate: last
              ? {
                  id: last.id,
                  certificateNumber: valuationCode("IPC", last.certificateNumber!),
                  valuationDate: toCalendarDate(last.valuationDate),
                  amountDueMinor: minorOf(last.amountDueMinor!),
                }
              : null,
            openValuation: open
              ? {
                  id: open.id,
                  number: valuationCode("VAL", open.number),
                  status: open.status as ValuationStatus,
                }
              : null,
          };
        }
        rows.push({
          project: projectRef(project.project),
          canReadValuations,
          canMeasure: this.access.can(project, MEASUREMENT_RECORD_PERMISSIONS),
          canApprove,
          ...position,
          pendingMeasurements: pending,
        });
      }
      return valuationsOverviewResponseSchema.parse({ projects: rows, approvalQueue });
    });
  }

  /** A project's valuations, certificates, retention ledger, settings and completions. */
  projectView(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.reader(scope, projectId);
      const [rows, contractSum, settings, completions] = await Promise.all([
        tx.valuation.findMany({
          where: { tenantId: access.tenantId, projectId },
          orderBy: { number: "desc" },
        }),
        contractSumOf(tx, access.tenantId, projectId),
        settingsInForce(tx, access.tenantId, projectId),
        tx.projectCompletion.findMany({
          where: { tenantId: access.tenantId, projectId, status: "certified" },
        }),
      ]);
      const people = await peopleOf(
        tx,
        rows.flatMap((row) => [row.createdBy, row.certifiedBy]),
      );
      const certified = rows
        .filter((row) => row.status === "certified")
        .sort((a, b) => a.certificateNumber! - b.certificateNumber!);
      let held = 0;
      let released = 0;
      const ledger = certified.map((row) => {
        const after = minorOf(row.retentionHeldMinor!);
        const movement = after - held;
        if (movement < 0) released -= movement;
        held = after;
        return {
          valuationId: row.id,
          certificateNumber: valuationCode("IPC", row.certificateNumber!),
          kind: row.kind as ValuationKind,
          releaseStage: row.releaseStage as ReleaseStage | null,
          valuationDate: toCalendarDate(row.valuationDate),
          certifiedAt: row.certifiedAt!.toISOString(),
          heldMinor: after,
          movementMinor: movement,
        };
      });
      const stage = (certified.at(-1)?.retentionStage ?? "none") as RetentionStage;
      const completion = (kind: "practical" | "final") => {
        const row = completions.find((entry) => entry.kind === kind);
        return row
          ? {
              completionDate: toCalendarDate(row.completionDate),
              dlpEndsOn: row.dlpEndsOn ? toCalendarDate(row.dlpEndsOn) : null,
            }
          : null;
      };
      const open = rows.some((row) => row.status === "draft" || row.status === "submitted");
      const canPrepare = this.access.can(project, VALUATION_PREPARE_PERMISSIONS) && !open;
      const live = (stageKey: ReleaseStage) =>
        rows.some(
          (row) =>
            row.kind === "retention_release" &&
            row.releaseStage === stageKey &&
            row.status !== "cancelled",
        );
      const finalReleased = live("final");
      const canRelease = (stageKey: ReleaseStage) =>
        canPrepare &&
        held > 0 &&
        completion(stageKey) !== null &&
        !live(stageKey) &&
        !(stageKey === "practical" && finalReleased);
      return projectValuationsResponseSchema.parse({
        project: projectRef(project.project),
        contractSum,
        settings: await settingsWire(tx, settings),
        valuations: rows.map((row) => summary(row, project, people)),
        retention: { heldMinor: held, releasedMinor: released, stage, ledger },
        certified: {
          count: certified.length,
          amountDueMinor: certified.reduce((sum, row) => sum + minorOf(row.amountDueMinor!), 0),
          vatMinor: certified.reduce((sum, row) => sum + minorOf(row.vatMinor!), 0),
          totalMinor: certified.reduce((sum, row) => sum + minorOf(row.totalMinor!), 0),
          workDoneMinor: certified.length ? minorOf(certified.at(-1)!.workDoneMinor!) : 0,
        },
        completions: { practical: completion("practical"), final: completion("final") },
        permissions: {
          canCreate: canPrepare && contractSum !== null,
          canRelease: { practical: canRelease("practical"), final: canRelease("final") },
          canEditSettings: this.access.can(project, CONTRACT_SETTINGS_PERMISSIONS),
        },
      });
    });
  }

  /** New contract settings version (finance.manage, on the version read). */
  updateSettings(
    principal: Principal,
    projectId: string,
    input: UpdateContractSettingsRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const project = await this.access.require(
            scope,
            projectId,
            CONTRACT_SETTINGS_PERMISSIONS,
            { writable: true },
          );
          const current = await settingsInForce(tx, access.tenantId, projectId);
          if (current.version !== input.version) throw versionConflict();
          await tx.contractSettings.create({
            data: {
              tenantId: access.tenantId,
              projectId,
              version: current.version + 1,
              retentionPercent: input.retentionPercent,
              retentionCapPercent: input.retentionCapPercent,
              vatPercent: input.vatPercent,
              materialsPercent: input.materialsPercent,
              practicalReleasePercent: input.practicalReleasePercent,
              createdBy: access.userId,
            },
          });
          await this.scope.audit(tx, "valuation.settings_updated", projectId, {
            projectId,
            version: current.version + 1,
          });
          return contractSettingsResponseSchema.parse({
            project: projectRef(project.project),
            settings: await settingsWire(tx, await settingsInForce(tx, access.tenantId, projectId)),
          });
        },
        true,
      )
      .catch((error: unknown) => {
        throw valuationDatabaseProblem(error) ?? error;
      });
  }

  create(principal: Principal, projectId: string, input: CreateValuationRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.access.require(scope, projectId, VALUATION_PREPARE_PERMISSIONS, {
            writable: true,
          });
          await lockProject(tx, access.tenantId, projectId);
          const kind = input.kind;
          const stage = input.releaseStage ?? null;
          const open = await tx.valuation.findFirst({
            where: { tenantId: access.tenantId, projectId, status: { in: ["draft", "submitted"] } },
          });
          if (open)
            throw valuationConflict(
              "valuation-open",
              `${valuationCode("VAL", open.number)} is still being prepared`,
            );
          if (!(await bqInForce(tx, access.tenantId, projectId)))
            throw valuationConflict("bq-not-approved", "The project has no approved BQ yet");
          const certified = await certifiedOf(tx, access.tenantId, projectId);
          const last = certified.at(-1);
          if (
            input.valuationDate > nairobiDate() ||
            (last && input.valuationDate < toCalendarDate(last.valuationDate))
          )
            throw valuationConflict(
              "valuation-date-invalid",
              "A valuation is dated on or after the last certificate and not in the future",
            );
          if (kind === "retention_release" && stage) {
            const completion = await tx.projectCompletion.findFirst({
              where: { tenantId: access.tenantId, projectId, kind: stage, status: "certified" },
            });
            if (!completion)
              throw valuationConflict(
                "completion-not-certified",
                `Retention is released after the ${stage} completion is certified`,
              );
            if (input.valuationDate < toCalendarDate(completion.completionDate))
              throw valuationConflict(
                "valuation-date-invalid",
                "A release is dated on or after the completion",
              );
            const existing = await tx.valuation.findFirst({
              where: {
                tenantId: access.tenantId,
                projectId,
                kind: "retention_release",
                status: { not: "cancelled" },
                releaseStage: stage === "practical" ? { in: ["practical", "final"] } : stage,
              },
            });
            if (existing)
              throw valuationConflict("release-exists", "This retention was already released");
            if (!last)
              throw valuationConflict(
                "no-certified-interim",
                "Retention is released only after an interim certificate",
              );
            if (minorOf(last.retentionHeldMinor!) <= 0)
              throw valuationConflict("nothing-to-release", "No retention is held");
          }
          const highest = await tx.valuation.aggregate({
            where: { tenantId: access.tenantId, projectId },
            _max: { number: true },
          });
          const id = nextId();
          const number = (highest._max.number ?? 0) + 1;
          await tx.valuation.create({
            data: {
              id,
              tenantId: access.tenantId,
              projectId,
              number,
              kind,
              releaseStage: stage,
              valuationDate: fromCalendarDate(input.valuationDate),
              notes: input.notes ?? null,
              materialsFromStores: kind === "interim" && (input.materialsFromStores ?? false),
              contributors: [access.userId],
              createdBy: access.userId,
              updatedBy: access.userId,
            },
          });
          await this.scope.audit(tx, "valuation.created", id, {
            projectId,
            number,
            kind,
            releaseStage: stage,
          });
          return this.detail(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        throw valuationDatabaseProblem(error) ?? error;
      });
  }

  get(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const row = await this.row(scope, id);
      await this.reader(scope, row.projectId);
      return this.detail(scope, id);
    });
  }

  update(principal: Principal, id: string, input: UpdateValuationRequest, req: Request) {
    return this.edit(principal, id, input.version, req, async (scope, row) => {
      if (input.valuationDate !== undefined && input.valuationDate > nairobiDate())
        throw valuationConflict("valuation-date-invalid", "A valuation is not dated in the future");
      await scope.tx.valuation.update({
        where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
        data: {
          ...(input.valuationDate !== undefined
            ? { valuationDate: fromCalendarDate(input.valuationDate) }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.materialsFromStores !== undefined && row.kind === "interim"
            ? { materialsFromStores: input.materialsFromStores }
            : {}),
        },
      });
      await this.scope.audit(scope.tx, "valuation.updated", id, {
        projectId: row.projectId,
        fields: Object.keys(input)
          .filter((key) => key !== "version")
          .sort(),
      });
    });
  }

  addMaterial(principal: Principal, id: string, input: AddValuationMaterialRequest, req: Request) {
    return this.edit(principal, id, input.version, req, async (scope, row) => {
      const { tx, access } = scope;
      if (row.kind !== "interim") throw invalidTransition(row.kind);
      const version = await bqInForce(tx, access.tenantId, row.projectId);
      const item = version
        ? await tx.bqItem.findUnique({
            where: {
              tenantId_versionId_lineageId: {
                tenantId: access.tenantId,
                versionId: version.id,
                lineageId: input.bqItemLineageId,
              },
            },
          })
        : null;
      if (!version || !item)
        throw valuationProblem(422, "bq-item-not-found", "The item is not in the BQ in force");
      if (measurementBasis(measurable(item)) === null)
        throw valuationProblem(
          422,
          "item-not-measurable",
          "Materials on site are entered against a measured item",
        );
      const count = await tx.valuationMaterial.count({
        where: { tenantId: access.tenantId, valuationId: id },
      });
      if (count >= VALUATION_LIMITS.materialsPerValuation)
        throw valuationConflict(
          "too-many-materials",
          "A valuation has at most 100 materials lines",
        );
      const materialId = nextId();
      await tx.valuationMaterial.create({
        data: {
          id: materialId,
          tenantId: access.tenantId,
          projectId: row.projectId,
          valuationId: id,
          bqVersionId: version.id,
          bqItemLineageId: item.lineageId,
          description: input.description,
          unit: input.unit ?? null,
          quantity: input.quantity,
          amountMinor: BigInt(input.amountMinor),
          reference: input.reference ?? null,
          createdBy: access.userId,
        },
      });
      await this.refuseAtOnce(tx, access.tenantId, row, "materials-exceed-remaining");
      await this.scope.audit(tx, "valuation.materials_added", id, {
        projectId: row.projectId,
        lineId: materialId,
        itemLineageId: item.lineageId,
      });
    });
  }

  removeMaterial(principal: Principal, id: string, lineId: string, version: number, req: Request) {
    return this.edit(principal, id, version, req, async (scope, row) => {
      const removed = await scope.tx.valuationMaterial.deleteMany({
        where: { tenantId: scope.access.tenantId, valuationId: id, id: lineId },
      });
      if (!removed.count) throw new NotFoundException("Materials line not found");
      await this.scope.audit(scope.tx, "valuation.materials_removed", id, {
        projectId: row.projectId,
        lineId,
      });
    });
  }

  addAdjustment(
    principal: Principal,
    id: string,
    input: AddValuationAdjustmentRequest,
    req: Request,
  ) {
    return this.edit(principal, id, input.version, req, async (scope, row) => {
      const { tx, access } = scope;
      if (row.kind !== "interim") throw invalidTransition(row.kind);
      const count = await tx.valuationAdjustment.count({
        where: { tenantId: access.tenantId, valuationId: id },
      });
      if (count >= VALUATION_LIMITS.adjustmentsPerValuation)
        throw valuationConflict("too-many-adjustments", "A valuation has at most 50 adjustments");
      const adjustmentId = nextId();
      await tx.valuationAdjustment.create({
        data: {
          id: adjustmentId,
          tenantId: access.tenantId,
          projectId: row.projectId,
          valuationId: id,
          kind: input.kind,
          description: input.description,
          amountMinor: BigInt(input.amountMinor),
          createdBy: access.userId,
        },
      });
      await this.refuseAtOnce(tx, access.tenantId, row, "recovery-exceeds-advance");
      await this.scope.audit(tx, "valuation.adjustment_added", id, {
        projectId: row.projectId,
        adjustmentId,
        kind: input.kind,
      });
    });
  }

  removeAdjustment(
    principal: Principal,
    id: string,
    adjustmentId: string,
    version: number,
    req: Request,
  ) {
    return this.edit(principal, id, version, req, async (scope, row) => {
      const removed = await scope.tx.valuationAdjustment.deleteMany({
        where: { tenantId: scope.access.tenantId, valuationId: id, id: adjustmentId },
      });
      if (!removed.count) throw new NotFoundException("Adjustment not found");
      await this.scope.audit(scope.tx, "valuation.adjustment_removed", id, {
        projectId: row.projectId,
        adjustmentId,
      });
    });
  }

  /** Freezes the lines and figures (next revision) with the digest a certifier will quote. */
  submit(principal: Principal, id: string, version: number, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.projectId, VALUATION_PREPARE_PERMISSIONS, {
            writable: true,
          });
          await lockProject(tx, access.tenantId, row.projectId);
          if (row.status !== "draft") throw invalidTransition(row.status);
          if (row.version !== version) throw versionConflict();
          const computed = await computeValuation(tx, access.tenantId, row);
          if (computed.problem) throw toProblem(computed.problem);
          const revision = row.revision + 1;
          await tx.valuation.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              ...frozenColumns(computed),
              status: "submitted",
              revision,
              submittedBy: access.userId,
              submittedAt: new Date(),
              returnReason: null,
              updatedBy: access.userId,
              updatedAt: new Date(),
              version: { increment: 1 },
            },
          });
          const rows = lineRows(access.tenantId, id, revision, computed);
          for (let index = 0; index < rows.length; index += 1_000)
            await tx.valuationLine.createMany({ data: rows.slice(index, index + 1_000) });
          await this.scope.audit(tx, "valuation.submitted", id, {
            projectId: row.projectId,
            number: row.number,
            revision,
            lines: rows.length,
          });
          return this.detail(scope, id);
        },
        true,
        30_000,
      )
      .catch((error: unknown) => {
        throw valuationDatabaseProblem(error) ?? error;
      });
  }

  /**
   * Certification: finance.manage + step-up, never a contributor, on the digest the certifier saw;
   * the valuation is recomputed and must still match it (409 valuation-stale otherwise).
   */
  certify(
    principal: Principal,
    id: string,
    input: { version: number; digest: string },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.projectId, VALUATION_CERTIFY_PERMISSIONS, {
            stepUp: true,
            writable: true,
          });
          await lockProject(tx, access.tenantId, row.projectId);
          if (row.status !== "submitted") throw invalidTransition(row.status);
          if (row.version !== input.version) throw versionConflict();
          if (row.contributors.includes(access.userId))
            throw makerChecker("Someone who prepared this valuation cannot certify it");
          const computed = await computeValuation(tx, access.tenantId, row);
          if (row.digest !== input.digest || computed.digest !== row.digest || computed.problem)
            throw valuationConflict(
              "valuation-stale",
              "The valuation changed since it was submitted; return it and submit again",
            );
          const highest = await tx.valuation.aggregate({
            where: { tenantId: access.tenantId, projectId: row.projectId },
            _max: { certificateNumber: true },
          });
          const certificateNumber = (highest._max.certificateNumber ?? 0) + 1;
          await tx.valuation.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              status: "certified",
              certificateNumber,
              certifiedBy: access.userId,
              certifiedAt: new Date(),
              version: { increment: 1 },
            },
          });
          await this.scope.audit(tx, "valuation.certified", id, {
            projectId: row.projectId,
            number: row.number,
            certificateNumber,
            kind: row.kind,
          });
          return this.detail(scope, id);
        },
        true,
        30_000,
      )
      .catch((error: unknown) => {
        throw valuationDatabaseProblem(error) ?? error;
      });
  }

  /** Return (certifier, reason) to draft, or cancel (preparer or certifier, reason). */
  decide(
    principal: Principal,
    id: string,
    action: "return" | "cancel",
    input: { version: number; reason: string },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(
            scope,
            row.projectId,
            action === "return"
              ? VALUATION_CERTIFY_PERMISSIONS
              : [...VALUATION_PREPARE_PERMISSIONS, ...VALUATION_CERTIFY_PERMISSIONS],
            { writable: true },
          );
          const allowed: ValuationStatus[] =
            action === "return" ? ["submitted"] : ["draft", "submitted"];
          if (!allowed.includes(row.status as ValuationStatus)) throw invalidTransition(row.status);
          if (row.version !== input.version) throw versionConflict();
          await tx.valuation.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data:
              action === "return"
                ? {
                    ...clearedColumns,
                    status: "draft",
                    returnReason: input.reason,
                    version: { increment: 1 },
                  }
                : {
                    status: "cancelled",
                    cancelledBy: access.userId,
                    cancelledAt: new Date(),
                    cancelReason: input.reason,
                    version: { increment: 1 },
                  },
          });
          await this.scope.audit(
            tx,
            action === "return" ? "valuation.returned" : "valuation.cancelled",
            id,
            { projectId: row.projectId, number: row.number, reasonGiven: true },
          );
          return this.detail(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        throw valuationDatabaseProblem(error) ?? error;
      });
  }

  // Helpers -------------------------------------------------------------------------------------

  private edit(
    principal: Principal,
    id: string,
    version: number,
    req: Request,
    work: (scope: Scope, row: ValuationRow) => Promise<void>,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.projectId, VALUATION_PREPARE_PERMISSIONS, {
            writable: true,
          });
          if (row.status !== "draft") throw invalidTransition(row.status);
          if (row.version !== version) throw versionConflict();
          await work(scope, row);
          await tx.valuation.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: { updatedBy: access.userId, updatedAt: new Date(), version: { increment: 1 } },
          });
          return this.detail(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        throw valuationDatabaseProblem(error) ?? error;
      });
  }

  /**
   * Refuses a new input at once when it alone would block the submission (materials beyond what
   * remains of an item, recoveries beyond advances); submission and the database check it again.
   */
  private async refuseAtOnce(
    tx: Scope["tx"],
    tenantId: string,
    row: ValuationRow,
    code: "materials-exceed-remaining" | "recovery-exceeds-advance",
  ) {
    const { problem } = await computeValuation(tx, tenantId, row);
    if (problem?.code === code) throw toProblem(problem);
  }

  async row(scope: Scope, id: string): Promise<ValuationRow> {
    const row = await scope.tx.valuation.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Valuation not found");
    return row;
  }

  /** The valuation as the API returns it: frozen figures, or a live preview while a draft. */
  async detail(scope: Scope, id: string) {
    return valuationResponseSchema.parse({ valuation: await this.detailOf(scope, id) });
  }

  async detailOf(scope: Scope, id: string): Promise<ValuationDetail> {
    const { tx, access } = scope;
    const row = await this.row(scope, id);
    const project = await this.access.on(scope, row.projectId);
    const frozen = row.totalMinor !== null;
    const computed = frozen ? null : await computeValuation(tx, access.tenantId, row);
    const lines = frozen
      ? storedToLines(await storedLines(tx, access.tenantId, id, row.revision))
      : computed!;
    const figures = frozen ? storedFigures(row) : computed!.figures;
    const terms = frozen ? storedTerms(row) : computed!.terms;
    const versionIds = [
      ...new Set(
        [...lines.items, ...lines.materials]
          .map((line) => line.bqVersionId)
          .filter((value): value is string => value !== null),
      ),
    ];
    const [bills, items, stores, materials, adjustments, bqVersion] = await Promise.all([
      tx.bqBill.findMany({
        where: { tenantId: access.tenantId, versionId: { in: versionIds } },
        select: { versionId: true, lineageId: true, number: true, title: true },
      }),
      tx.bqItem.findMany({
        where: {
          tenantId: access.tenantId,
          OR: lines.materials
            .filter((line) => line.lineageId && line.bqVersionId)
            .map((line) => ({ versionId: line.bqVersionId!, lineageId: line.lineageId! })),
        },
        include: { bill: { select: { lineageId: true, number: true, title: true } } },
      }),
      tx.store.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: lines.materials.flatMap((line) => (line.storeId ? [line.storeId] : [])) },
        },
        select: { id: true, name: true },
      }),
      tx.valuationMaterial.findMany({
        where: { tenantId: access.tenantId, valuationId: id },
        orderBy: { createdAt: "asc" },
        include: {
          item: { include: { bill: { select: { lineageId: true, number: true, title: true } } } },
        },
      }),
      tx.valuationAdjustment.findMany({
        where: { tenantId: access.tenantId, valuationId: id },
        orderBy: { createdAt: "asc" },
      }),
      (frozen ? row.bqVersionId : computed!.bqVersion?.id)
        ? tx.bqVersion.findUnique({
            where: {
              tenantId_id: {
                tenantId: access.tenantId,
                id: (frozen ? row.bqVersionId : computed!.bqVersion!.id)!,
              },
            },
            select: { id: true, versionNo: true },
          })
        : Promise.resolve(null),
    ]);
    const people = await peopleOf(tx, [
      row.createdBy,
      row.submittedBy,
      row.certifiedBy,
      row.cancelledBy,
      ...materials.map((line) => line.createdBy),
      ...adjustments.map((line) => line.createdBy),
    ]);
    const billOf = (versionId: string, lineageId: string) =>
      bills.find((bill) => bill.versionId === versionId && bill.lineageId === lineageId);
    const itemRef = (versionId: string, lineageId: string) =>
      items.find((item) => item.versionId === versionId && item.lineageId === lineageId);
    let lineNo = 0;
    const status = row.status as ValuationStatus;
    const canPrepare = this.access.can(project, VALUATION_PREPARE_PERMISSIONS);
    const canCertify = this.access.can(project, VALUATION_CERTIFY_PERMISSIONS);
    const contributor = row.contributors.includes(access.userId);
    return {
      ...summary(row, project, people),
      notes: row.notes,
      materialsFromStores: row.materialsFromStores,
      returnReason: row.returnReason,
      cancelReason: row.cancelReason,
      cancelledBy: row.cancelledBy ? personOf(people, row.cancelledBy) : null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      submittedBy: row.submittedBy ? personOf(people, row.submittedBy) : null,
      bqVersion,
      contractSum: frozen
        ? {
            originalMinor: minorOf(row.originalContractSumMinor!),
            revisedMinor: minorOf(row.revisedContractSumMinor!),
            revisedVersionNo: bqVersion?.versionNo ?? 1,
          }
        : computed!.contractSum,
      terms,
      figures,
      preview: !frozen,
      digest: row.digest,
      revision: row.revision,
      lines: {
        items: lines.items.map((line) => {
          const bill = billOf(line.bqVersionId, line.billLineageId);
          return {
            lineNo: (lineNo += 1),
            bqItem: {
              versionId: line.bqVersionId,
              lineageId: line.lineageId,
              ref: line.ref,
              description: line.description,
              unit: line.unit,
              bill: bill
                ? { lineageId: bill.lineageId, number: bill.number, title: bill.title }
                : null,
            },
            kind: line.itemKind,
            basis: line.basis,
            itemQuantity: line.itemQuantity,
            rate: line.rate,
            itemAmountMinor: line.itemAmountMinor,
            measurementId: line.measurementId,
            measuredOn: line.measuredOn,
            quantityToDate: line.quantityToDate,
            percentComplete: line.percentComplete,
            overMeasured: line.overMeasured,
            previousMinor: line.previousMinor,
            toDateMinor: line.amountMinor,
            thisPeriodMinor: line.amountMinor - line.previousMinor,
          };
        }),
        materials: lines.materials.map((line) => {
          const item =
            line.lineageId && line.bqVersionId ? itemRef(line.bqVersionId, line.lineageId) : null;
          const store = line.storeId ? stores.find((entry) => entry.id === line.storeId) : null;
          return {
            lineNo: (lineNo += 1),
            source: line.source,
            description: line.description,
            unit: line.unit,
            quantity: line.quantity,
            amountMinor: line.amountMinor,
            bqItem: item
              ? {
                  versionId: item.versionId,
                  lineageId: item.lineageId,
                  ref: item.ref,
                  description: item.description,
                  unit: item.unit,
                  bill: item.bill,
                }
              : null,
            store: store ?? null,
            reference: line.reference,
          };
        }),
        adjustments: lines.adjustments.map((line) => ({
          lineNo: (lineNo += 1),
          kind: line.adjustmentKind,
          description: line.description,
          amountMinor: line.amountMinor,
        })),
      },
      inputs: {
        materials: materials.map((line) => ({
          id: line.id,
          bqItem: {
            versionId: line.item.versionId,
            lineageId: line.item.lineageId,
            ref: line.item.ref,
            description: line.item.description,
            unit: line.item.unit,
            bill: line.item.bill,
          },
          description: line.description,
          unit: line.unit,
          quantity: trimDecimal(line.quantity),
          amountMinor: minorOf(line.amountMinor),
          reference: line.reference,
          createdBy: personOf(people, line.createdBy),
        })),
        adjustments: adjustments.map((line) => ({
          id: line.id,
          kind: line.kind as AdjustmentKind,
          description: line.description,
          amountMinor: minorOf(line.amountMinor),
          createdBy: personOf(people, line.createdBy),
        })),
      },
      warnings: computed?.warnings ?? [],
      permissions: {
        canEdit: status === "draft" && canPrepare,
        canSubmit: status === "draft" && canPrepare,
        canCertify: status === "submitted" && canCertify && !contributor,
        canReturn: status === "submitted" && canCertify,
        canCancel: (status === "draft" || status === "submitted") && (canPrepare || canCertify),
      },
    };
  }
}

function summary(row: ValuationRow, project: ProjectAccess, people: People): ValuationSummary {
  return {
    id: row.id,
    project: projectRef(project.project),
    number: valuationCode("VAL", row.number),
    certificateNumber:
      row.certificateNumber === null ? null : valuationCode("IPC", row.certificateNumber),
    kind: row.kind as ValuationKind,
    releaseStage: row.releaseStage as ReleaseStage | null,
    status: row.status as ValuationStatus,
    valuationDate: toCalendarDate(row.valuationDate),
    amountDueMinor: row.amountDueMinor === null ? null : minorOf(row.amountDueMinor),
    totalMinor: row.totalMinor === null ? null : minorOf(row.totalMinor),
    createdBy: personOf(people, row.createdBy),
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    certifiedBy: row.certifiedBy ? personOf(people, row.certifiedBy) : null,
    certifiedAt: row.certifiedAt?.toISOString() ?? null,
    version: row.version,
  };
}

export { BadRequestException };
