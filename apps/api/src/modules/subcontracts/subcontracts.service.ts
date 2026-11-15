import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  advanceRecoverable,
  checkLineAgainstBq,
  measurementBasis,
  nairobiDate,
  scaled,
  subcontractChangeMinor,
  subcontractLineAmountMinor,
  sumQuantities,
} from "@pm-buddy/domain";
import {
  SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS,
  SUBCONTRACT_ADVANCE_REQUEST_PERMISSIONS,
  SUBCONTRACT_APPROVE_PERMISSIONS,
  SUBCONTRACT_LIMITS,
  SUBCONTRACT_PAY_PERMISSIONS,
  SUBCONTRACT_PREPARE_PERMISSIONS,
  SUBCONTRACT_READ_PERMISSIONS,
  PIECE_RATE_READ_PERMISSIONS,
  type SubcontractAdvanceStatus,
  type SubcontractCertificateKind,
  type SubcontractCertificateStatus,
  type SubcontractKind,
  type SubcontractLineBasis,
  type SubcontractPaymentMethod,
  type SubcontractStatus,
  type SubcontractVariationStatus,
  type SubcontractVatTreatment,
  type ReleaseStage,
} from "@pm-buddy/types";
import {
  projectSubcontractsResponseSchema,
  subcontractItemsResponseSchema,
  subcontractResponseSchema,
  subcontractsOverviewResponseSchema,
  type CreateSubcontractAdvanceRequest,
  type ParsedAddSubcontractLineRequest,
  type ParsedCreateSubcontractRequest,
  type ParsedSubcontractVariationRequest,
  type PaySubcontractAdvanceRequest,
  type SubcontractDetail,
  type SubcontractPosition,
  type SubcontractSummary,
  type UpdateSubcontractRequest,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import {
  minorOf,
  projectRef,
  trimDecimal,
  type ProjectAccess,
} from "../finance/spending-common.js";
import { nextId } from "../procurement/catalogue-store.js";
import { requestDigest } from "../procurement/p2p/p2p-common.js";
import { peopleOf, personOf, type People } from "../procurement/procurement-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import { bqInForce, measurable } from "../progress/valuations/valuation-common.js";
import {
  SubcontractAccess,
  codes,
  decimalOrNull,
  invalidTransition,
  itemWire,
  itemWithBill,
  lastCertifiedLines,
  letOn,
  linesOf,
  lockSubcontract,
  makerChecker,
  measuredAt,
  projectLets,
  subcontractConflict,
  subcontractProblem,
  supplierRef,
  supplierSelect,
  versionConflict,
  type LineInForce,
  type Tx,
} from "./subcontracts-common.js";

type SubcontractRecord = Prisma.SubcontractGetPayload<{
  include: { supplier: { select: typeof supplierSelect } };
}>;
type AdvanceRow = Prisma.SubcontractAdvanceGetPayload<object>;
type Problem = { code: string; ref: string | null };

const OPEN_FOR_WORK: SubcontractStatus[] = ["approved", "active"];

/** A variation's digest: the same whichever order its lines and changes are listed or read in. */
function variationDigest(content: {
  subcontractId: string;
  number: number;
  reason: string;
  additions: {
    lineage: string;
    quantity: string;
    rateMinor: number | null;
    amountMinor: number;
    vatTreatment: string;
  }[];
  changes: {
    lineId: string;
    quantityChange: string;
    amountChangeMinor: number;
    overQuantityReason: string | null;
  }[];
  valueChangeMinor: number;
}) {
  const byKey = (key: string, other: string) => (key < other ? -1 : key > other ? 1 : 0);
  return requestDigest("subcontract.variation", {
    ...content,
    additions: content.additions
      .map((line) => ({ ...line, quantity: scaled(line.quantity, 4).toString() }))
      .sort((x, y) => byKey(x.lineage, y.lineage)),
    changes: content.changes
      .map((change) => ({
        ...change,
        quantityChange: scaled(change.quantityChange, 4).toString(),
      }))
      .sort((x, y) => byKey(x.lineId, y.lineId)),
  });
}
const percentText = (value: string | null | undefined) => value ?? null;

/**
 * Subcontracts (D6.3 part B, brief §5.14 and §15 C; WORKFLOWS "Subcontracts" and "Subcontract
 * advances"; ARCHITECTURE §4.16): a `bq.edit` holder lets scope lines on BQ items of the BQ in
 * force to a D5.1 supplier flagged as a subcontractor, at the subcontract's own rates, and submits
 * it with a digest; a `procurement.approve` holder who never contributed approves it with step-up
 * on that digest. Approved subcontracts change only through append-only, independently approved
 * variations; the live lines on a BQ item never exceed the item's BQ quantity without a reason.
 * Advances are maker-checked three ways and recorded as paid outside PM-Buddy.
 */
@Injectable()
export class SubcontractsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SubcontractAccess,
  ) {}

  // Reads ----------------------------------------------------------------------------------------

  overview(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const ids = await this.access.projectIds(scope, SUBCONTRACT_READ_PERMISSIONS);
      const projects = [];
      for (const projectId of ids) {
        const project = await this.access.on(scope, projectId);
        const rows = await tx.subcontract.findMany({
          where: { tenantId: access.tenantId, projectId },
          include: { supplier: { select: supplierSelect } },
        });
        const summaries = await this.summaries(tx, access.tenantId, rows, project);
        projects.push({
          project: projectRef(project.project),
          subcontracts: rows.length,
          live: rows.filter((row) => OPEN_FOR_WORK.includes(row.status as SubcontractStatus))
            .length,
          committedMinor: summaries.reduce((sum, row) => sum + row.committedMinor, 0),
          certifiedWorkMinor: summaries.reduce(
            (sum, row) => sum + row.position.certifiedWorkMinor,
            0,
          ),
          retentionHeldMinor: summaries.reduce(
            (sum, row) => sum + row.position.retentionHeldMinor,
            0,
          ),
          advancesOutstandingMinor: summaries.reduce(
            (sum, row) => sum + row.position.advancesOutstandingMinor,
            0,
          ),
          openCertificates: summaries.filter((row) => row.openCertificate !== null).length,
          pendingApprovals: rows.filter((row) => row.status === "submitted").length,
        });
      }
      const pieceRateProjects = await this.access.projectIds(scope, PIECE_RATE_READ_PERMISSIONS);
      const pieceRate = await tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: pieceRateProjects } },
        orderBy: { code: "asc" },
      });
      if (
        ![...SUBCONTRACT_READ_PERMISSIONS, ...PIECE_RATE_READ_PERMISSIONS].some((permission) =>
          access.permissions.has(permission),
        )
      )
        throw new ForbiddenException("No permission to see subcontracts or piece-rate jobs");
      return subcontractsOverviewResponseSchema.parse({
        projects,
        subcontractors: ids.length ? await this.subcontractors(tx, access.tenantId) : [],
        pieceRateProjects: pieceRate.map(projectRef),
      });
    });
  }

  projectList(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.access.reader(scope, projectId);
      const rows = await tx.subcontract.findMany({
        where: { tenantId: access.tenantId, projectId },
        include: { supplier: { select: supplierSelect } },
        orderBy: { number: "desc" },
        take: SUBCONTRACT_LIMITS.listSize,
      });
      const subcontracts = await this.summaries(tx, access.tenantId, rows, project);
      const sum = (pick: (row: SubcontractSummary) => number) =>
        subcontracts.reduce((total, row) => total + pick(row), 0);
      return projectSubcontractsResponseSchema.parse({
        project: projectRef(project.project),
        subcontracts,
        subcontractors: await this.subcontractors(tx, access.tenantId),
        totals: {
          committedMinor: sum((row) => row.committedMinor),
          certifiedWorkMinor: sum((row) => row.position.certifiedWorkMinor),
          retentionHeldMinor: sum((row) => row.position.retentionHeldMinor),
          advancesOutstandingMinor: sum((row) => row.position.advancesOutstandingMinor),
          outstandingMinor: sum((row) => row.position.outstandingMinor),
        },
        permissions: {
          canCreate: this.access.can(project, SUBCONTRACT_PREPARE_PERMISSIONS),
          canReadPieceRate: this.access.holds(project, [
            "payroll.view",
            "payroll.prepare",
            "attendance.record",
            "timesheets.approve",
          ]),
        },
      });
    });
  }

  /** BQ items of the BQ in force that can be let, with what live subcontracts already let. */
  items(
    principal: Principal,
    projectId: string,
    query: { search?: string; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      await this.access.reader(scope, projectId);
      const version = await bqInForce(tx, access.tenantId, projectId);
      const rows = version
        ? await tx.bqItem.findMany({
            where: { tenantId: access.tenantId, versionId: version.id },
            include: itemWithBill,
            orderBy: [{ bill: { sortOrder: "asc" } }, { sortOrder: "asc" }],
          })
        : [];
      const lets = await projectLets(tx, access.tenantId, projectId);
      const needle = query.search?.trim().toLowerCase();
      const letable = rows.filter((item) => {
        if (measurementBasis(measurable(item)) === null) return false;
        if (!needle) return true;
        return (
          (item.ref ?? "").toLowerCase().includes(needle) ||
          item.description.toLowerCase().includes(needle)
        );
      });
      const offset = query.cursor ? Number(query.cursor) : 0;
      const page = letable.slice(offset, offset + query.limit);
      const hasMore = offset + query.limit < letable.length;
      return subcontractItemsResponseSchema.parse({
        bqVersion: version ? { id: version.id, versionNo: version.versionNo } : null,
        items: page.map((item) => {
          const basis = measurementBasis(measurable(item)) as SubcontractLineBasis;
          const capacity = basis === "quantity" ? trimDecimal(item.quantity!) : "100";
          const let_ = letOn(lets, item.lineageId);
          const available = scaled(capacity, 4) - scaled(let_, 4);
          return {
            ...itemWire(item),
            basis,
            bqQuantity: decimalOrNull(item.quantity),
            bqRate: decimalOrNull(item.rate),
            letQuantity: let_,
            availableQuantity: available > 0n ? sumQuantities([capacity, `-${let_}`]) : "0",
          };
        }),
        page: { hasMore, nextCursor: hasMore ? String(offset + query.limit) : null },
      });
    });
  }

  get(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => this.detail(scope, id));
  }

  // Draft ---------------------------------------------------------------------------------------

  create(
    principal: Principal,
    projectId: string,
    input: ParsedCreateSubcontractRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.require(scope, projectId, SUBCONTRACT_PREPARE_PERMISSIONS, {
          writable: true,
        });
        await this.eligibleSupplier(tx, access.tenantId, input.supplierId);
        await tx.$queryRaw`SELECT id FROM projects WHERE tenant_id = ${access.tenantId}::uuid AND id = ${projectId}::uuid FOR UPDATE`;
        const highest = await tx.subcontract.aggregate({
          where: { tenantId: access.tenantId, projectId },
          _max: { number: true },
        });
        const id = nextId();
        const number = (highest._max.number ?? 0) + 1;
        await tx.subcontract.create({
          data: {
            id,
            tenantId: access.tenantId,
            projectId,
            number,
            supplierId: input.supplierId,
            kind: input.kind,
            title: input.title,
            scope: input.scope ?? null,
            startDate: fromCalendarDate(input.startDate),
            endDate: fromCalendarDate(input.endDate),
            retentionPercent: input.retentionPercent,
            retentionLimitPercent: input.retentionLimitPercent,
            practicalReleasePercent: input.practicalReleasePercent,
            vatPercent: input.vatPercent,
            whtPercent: input.whtPercent,
            advanceLimitMinor: BigInt(input.advanceLimitMinor),
            advanceRecoveryPercent: input.advanceRecoveryPercent,
            paymentTermsDays: input.paymentTermsDays,
            paymentTermsNote: input.paymentTermsNote ?? null,
            contributors: [access.userId],
            createdBy: access.userId,
            updatedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "subcontract.created", id, {
          projectId,
          number,
          kind: input.kind,
        });
        return subcontractResponseSchema.parse({ subcontract: await this.detailOf(scope, id) });
      },
      true,
    );
  }

  update(principal: Principal, id: string, input: UpdateSubcontractRequest, req: Request) {
    return this.draftEdit(principal, id, input.version, req, async (scope, row) => {
      const { tx, access } = scope;
      if (input.supplierId && input.supplierId !== row.supplierId)
        await this.eligibleSupplier(tx, access.tenantId, input.supplierId);
      const startDate = input.startDate ?? toCalendarDate(row.startDate);
      const endDate = input.endDate ?? toCalendarDate(row.endDate);
      if (endDate < startDate)
        throw subcontractProblem(422, "subcontract-rule", "The end date is before the start date");
      const advance = input.advanceLimitMinor ?? minorOf(row.advanceLimitMinor);
      const recovery = input.advanceRecoveryPercent ?? trimDecimal(row.advanceRecoveryPercent);
      if (advance > 0 && Number(recovery) <= 0)
        throw subcontractConflict(
          "advance-not-recoverable",
          "An advance needs a recovery percentage",
        );
      await tx.subcontract.update({
        where: { tenantId_id: { tenantId: access.tenantId, id } },
        data: {
          ...(input.supplierId ? { supplierId: input.supplierId } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          startDate: fromCalendarDate(startDate),
          endDate: fromCalendarDate(endDate),
          ...(input.retentionPercent !== undefined
            ? { retentionPercent: input.retentionPercent }
            : {}),
          ...(input.retentionLimitPercent !== undefined
            ? { retentionLimitPercent: input.retentionLimitPercent }
            : {}),
          ...(input.practicalReleasePercent !== undefined
            ? { practicalReleasePercent: input.practicalReleasePercent }
            : {}),
          ...(input.vatPercent !== undefined ? { vatPercent: input.vatPercent } : {}),
          ...(input.whtPercent !== undefined ? { whtPercent: input.whtPercent } : {}),
          advanceLimitMinor: BigInt(advance),
          advanceRecoveryPercent: recovery,
          ...(input.paymentTermsDays !== undefined
            ? { paymentTermsDays: input.paymentTermsDays }
            : {}),
          ...(input.paymentTermsNote !== undefined
            ? { paymentTermsNote: input.paymentTermsNote }
            : {}),
        },
      });
      await this.scope.audit(tx, "subcontract.updated", id, {
        projectId: row.projectId,
        fields: Object.keys(input).filter((key) => key !== "version"),
      });
    });
  }

  addLine(principal: Principal, id: string, input: ParsedAddSubcontractLineRequest, req: Request) {
    return this.draftEdit(principal, id, input.version, req, async (scope, row) => {
      const { tx, access } = scope;
      const lines = await linesOf(tx, access.tenantId, id);
      if (lines.length >= SUBCONTRACT_LIMITS.linesPerSubcontract)
        throw subcontractConflict("too-many-lines", "A subcontract has at most 500 lines");
      if (lines.some((line) => line.row.bqItemLineageId === input.bqItemLineageId))
        throw subcontractConflict("line-exists", "This BQ item is already on the subcontract");
      const prepared = await this.prepareLine(tx, access.tenantId, row.projectId, input, row.id);
      await tx.subcontractLine.create({
        data: {
          id: nextId(),
          tenantId: access.tenantId,
          projectId: row.projectId,
          subcontractId: id,
          lineNo: Math.max(0, ...lines.map((line) => line.row.lineNo)) + 1,
          ...prepared,
          createdBy: access.userId,
        },
      });
      await this.scope.audit(tx, "subcontract.line_added", id, {
        projectId: row.projectId,
        bqItemLineageId: input.bqItemLineageId,
      });
    });
  }

  removeLine(principal: Principal, id: string, lineId: string, version: number, req: Request) {
    return this.draftEdit(principal, id, version, req, async (scope, row) => {
      const removed = await scope.tx.subcontractLine.deleteMany({
        where: { tenantId: scope.access.tenantId, subcontractId: id, id: lineId },
      });
      if (!removed.count) throw new NotFoundException("Line not found");
      await this.scope.audit(scope.tx, "subcontract.line_removed", id, {
        projectId: row.projectId,
        lineId,
      });
    });
  }

  // Lifecycle -----------------------------------------------------------------------------------

  /**
   * submit (preparer, digest frozen) · approve (procurement.approve + step-up, never a
   * contributor, on the digest seen) · return (approver, reason) · activate · complete ·
   * terminate (procurement.approve + step-up, reason) · cancel (reason).
   */
  transition(
    principal: Principal,
    id: string,
    action: "submit" | "approve" | "return" | "activate" | "complete" | "terminate" | "cancel",
    input: { version: number; digest?: string; reason?: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.record(scope, id);
        const permissions =
          action === "submit"
            ? SUBCONTRACT_PREPARE_PERMISSIONS
            : action === "approve" || action === "return" || action === "terminate"
              ? SUBCONTRACT_APPROVE_PERMISSIONS
              : [...SUBCONTRACT_PREPARE_PERMISSIONS, ...SUBCONTRACT_APPROVE_PERMISSIONS];
        await this.access.require(scope, row.projectId, permissions, {
          writable: true,
          stepUp: action === "approve" || action === "terminate",
        });
        await lockSubcontract(tx, access.tenantId, id);
        if (row.version !== input.version) throw versionConflict();
        const from: Record<typeof action, SubcontractStatus[]> = {
          submit: ["draft"],
          approve: ["submitted"],
          return: ["submitted"],
          activate: ["approved"],
          complete: ["active"],
          terminate: ["approved", "active"],
          cancel: ["draft", "submitted"],
        };
        if (!from[action].includes(row.status as SubcontractStatus))
          throw invalidTransition(row.status);
        const base = { updatedBy: access.userId, updatedAt: new Date(), version: { increment: 1 } };
        if (action === "submit" || action === "approve") {
          const check = await this.readiness(tx, access.tenantId, row);
          const blocking = check.problems[0];
          if (blocking)
            throw subcontractConflict(
              blocking.code as "subcontract-empty",
              blocking.ref
                ? `${problemText(blocking.code)} (${blocking.ref})`
                : problemText(blocking.code),
            );
          if (action === "submit") {
            await tx.subcontract.update({
              where: { tenantId_id: { tenantId: access.tenantId, id } },
              data: {
                ...base,
                status: "submitted",
                digest: check.digest,
                submittedBy: access.userId,
                submittedAt: new Date(),
                returnReason: null,
              },
            });
          } else {
            if (row.contributors.includes(access.userId))
              throw makerChecker("Someone who prepared this subcontract cannot approve it");
            if (row.digest !== input.digest || check.digest !== row.digest)
              throw subcontractConflict(
                "subcontract-stale",
                "The subcontract changed since it was submitted; reload and approve again",
              );
            await tx.subcontract.update({
              where: { tenantId_id: { tenantId: access.tenantId, id } },
              data: {
                ...base,
                status: "approved",
                approvedBy: access.userId,
                approvedAt: new Date(),
                originalValueMinor: BigInt(check.valueMinor),
                currentValueMinor: BigInt(check.valueMinor),
                contractVersion: 1,
              },
            });
          }
        } else if (action === "return") {
          await tx.subcontract.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: { ...base, status: "draft", digest: null, returnReason: input.reason ?? null },
          });
        } else if (action === "activate") {
          await tx.subcontract.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              ...base,
              status: "active",
              activatedBy: access.userId,
              activatedAt: new Date(),
            },
          });
        } else if (action === "complete" || action === "terminate") {
          const open =
            (await tx.subcontractCertificate.count({
              where: {
                tenantId: access.tenantId,
                subcontractId: id,
                status: { in: ["draft", "submitted"] },
              },
            })) +
            (await tx.subcontractVariation.count({
              where: { tenantId: access.tenantId, subcontractId: id, status: "pending" },
            })) +
            (await tx.subcontractAdvance.count({
              where: {
                tenantId: access.tenantId,
                subcontractId: id,
                status: { in: ["requested", "approved"] },
              },
            }));
          if (open)
            throw subcontractConflict(
              "subcontract-has-open-items",
              "Finish or cancel the open certificate, variation or advance first",
            );
          await tx.subcontract.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              ...base,
              status: action === "complete" ? "completed" : "terminated",
              closedBy: access.userId,
              closedAt: new Date(),
              closeReason: input.reason ?? null,
            },
          });
        } else {
          await tx.subcontract.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              ...base,
              status: "cancelled",
              cancelledBy: access.userId,
              cancelledAt: new Date(),
              cancelReason: input.reason ?? null,
            },
          });
        }
        await this.scope.audit(tx, `subcontract.${actionEvent[action]}`, id, {
          projectId: row.projectId,
          number: row.number,
          ...(input.reason ? { reasonGiven: true } : {}),
        });
        return subcontractResponseSchema.parse({ subcontract: await this.detailOf(scope, id) });
      },
      true,
      30_000,
    );
  }

  // Variations -------------------------------------------------------------------------------

  vary(principal: Principal, id: string, input: ParsedSubcontractVariationRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.record(scope, id);
        await this.access.require(scope, row.projectId, SUBCONTRACT_PREPARE_PERMISSIONS, {
          writable: true,
        });
        await lockSubcontract(tx, access.tenantId, id);
        if (!OPEN_FOR_WORK.includes(row.status as SubcontractStatus))
          throw invalidTransition(row.status);
        if (
          await tx.subcontractVariation.count({
            where: { tenantId: access.tenantId, subcontractId: id, status: "pending" },
          })
        )
          throw subcontractConflict(
            "subcontract-variation-open",
            "A variation is already waiting for a decision",
          );
        const lines = await linesOf(tx, access.tenantId, id);
        const lets = await projectLets(tx, access.tenantId, row.projectId);
        const certified = await this.claimedLines(tx, access.tenantId, id);
        const additions = [];
        for (const addition of input.additions) {
          if (
            lines.some(
              (line) =>
                line.row.bqItemLineageId === addition.bqItemLineageId &&
                (line.inForce || line.row.variation?.status === "pending"),
            ) ||
            input.additions.filter((other) => other.bqItemLineageId === addition.bqItemLineageId)
              .length > 1
          )
            throw subcontractConflict("line-exists", "This BQ item is already on the subcontract");
          additions.push(await this.prepareLine(tx, access.tenantId, row.projectId, addition, id));
        }
        const changes = [];
        for (const change of input.changes) {
          const line = lines.find((entry) => entry.row.id === change.lineId && entry.inForce);
          if (!line) throw new NotFoundException("Line not found");
          const next = sumQuantities([line.quantity, change.quantityChange]);
          const floor = certified.get(line.row.id) ?? "0";
          if (scaled(next, 4) < 0n || scaled(next, 4) < scaled(floor, 4))
            throw subcontractConflict(
              "line-below-certified",
              `A line cannot go below what was certified (${line.row.bqItem.ref ?? line.row.description})`,
            );
          if (line.row.basis === "percent" && scaled(next, 4) > 1_000_000n)
            throw subcontractProblem(422, "subcontract-rule", "A lump-sum share cannot pass 100 %");
          if (scaled(change.quantityChange, 4) > 0n) {
            const capacity = await this.capacity(
              tx,
              access.tenantId,
              row.projectId,
              line.row.bqItemLineageId,
            );
            const check = checkLineAgainstBq({
              bqQuantity: capacity,
              others: letOn(lets, line.row.bqItemLineageId, id),
              quantity: next,
              exceptionReason: change.overQuantityReason ?? line.row.overQuantityReason,
            });
            if (!check.ok)
              throw subcontractConflict(
                "over-bq-quantity",
                `This takes the BQ item above its quantity; give a reason (${line.row.bqItem.ref ?? ""})`,
              );
          }
          changes.push({
            lineId: line.row.id,
            quantityChange: change.quantityChange,
            amountChangeMinor: subcontractChangeMinor(line.terms, change.quantityChange),
            overQuantityReason: change.overQuantityReason ?? null,
          });
        }
        const valueChangeMinor =
          additions.reduce((sum, line) => sum + minorOf(line.amountMinor), 0) +
          changes.reduce((sum, change) => sum + change.amountChangeMinor, 0);
        const highest = await tx.subcontractVariation.aggregate({
          where: { tenantId: access.tenantId, subcontractId: id },
          _max: { number: true },
        });
        const number = (highest._max.number ?? 0) + 1;
        const variationId = nextId();
        const digest = variationDigest({
          subcontractId: id,
          number,
          reason: input.reason,
          additions: additions.map((line) => ({
            lineage: line.bqItemLineageId,
            quantity: line.quantity,
            rateMinor: line.rateMinor === null ? null : minorOf(line.rateMinor),
            amountMinor: minorOf(line.amountMinor),
            vatTreatment: line.vatTreatment,
          })),
          changes,
          valueChangeMinor,
        });
        await tx.subcontractVariation.create({
          data: {
            id: variationId,
            tenantId: access.tenantId,
            projectId: row.projectId,
            subcontractId: id,
            number,
            reason: input.reason,
            valueChangeMinor: BigInt(valueChangeMinor),
            digest,
            createdBy: access.userId,
          },
        });
        let lineNo = Math.max(0, ...lines.map((line) => line.row.lineNo));
        for (const addition of additions)
          await tx.subcontractLine.create({
            data: {
              id: nextId(),
              tenantId: access.tenantId,
              projectId: row.projectId,
              subcontractId: id,
              variationId,
              lineNo: (lineNo += 1),
              ...addition,
              createdBy: access.userId,
            },
          });
        for (const change of changes)
          await tx.subcontractLineChange.create({
            data: {
              tenantId: access.tenantId,
              subcontractId: id,
              variationId,
              lineId: change.lineId,
              quantityChange: change.quantityChange,
              amountChangeMinor: BigInt(change.amountChangeMinor),
              overQuantityReason: change.overQuantityReason,
            },
          });
        await this.scope.audit(tx, "subcontract.variation_raised", id, {
          projectId: row.projectId,
          variationId,
          number,
          additions: additions.length,
          changes: changes.length,
        });
        return subcontractResponseSchema.parse({ subcontract: await this.detailOf(scope, id) });
      },
      true,
      30_000,
    );
  }

  decideVariation(
    principal: Principal,
    id: string,
    variationId: string,
    action: "approve" | "reject",
    input: { version: number; digest?: string; reason?: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.record(scope, id);
        await this.access.require(scope, row.projectId, SUBCONTRACT_APPROVE_PERMISSIONS, {
          writable: true,
          stepUp: action === "approve",
        });
        await lockSubcontract(tx, access.tenantId, id);
        const variation = await tx.subcontractVariation.findFirst({
          where: { tenantId: access.tenantId, subcontractId: id, id: variationId },
        });
        if (!variation) throw new NotFoundException("Variation not found");
        if (variation.status !== "pending") throw invalidTransition(variation.status);
        if (variation.version !== input.version) throw versionConflict();
        if (variation.createdBy === access.userId)
          throw makerChecker("The person who raised a variation cannot decide it");
        if (action === "reject") {
          await tx.subcontractVariation.update({
            where: { tenantId_id: { tenantId: access.tenantId, id: variationId } },
            data: {
              status: "rejected",
              decidedBy: access.userId,
              decidedAt: new Date(),
              decisionReason: input.reason ?? null,
              version: { increment: 1 },
            },
          });
        } else {
          // Recomputed from the stored lines and changes, so nothing added after it was raised
          // is approved unseen.
          const [added, changed] = await Promise.all([
            tx.subcontractLine.findMany({
              where: { tenantId: access.tenantId, variationId },
            }),
            tx.subcontractLineChange.findMany({
              where: { tenantId: access.tenantId, variationId },
            }),
          ]);
          const stored = variationDigest({
            subcontractId: id,
            number: variation.number,
            reason: variation.reason,
            additions: added.map((line) => ({
              lineage: line.bqItemLineageId,
              quantity: line.quantity.toString(),
              rateMinor: line.rateMinor === null ? null : minorOf(line.rateMinor),
              amountMinor: minorOf(line.amountMinor),
              vatTreatment: line.vatTreatment,
            })),
            changes: changed.map((change) => ({
              lineId: change.lineId,
              quantityChange: change.quantityChange.toString(),
              amountChangeMinor: minorOf(change.amountChangeMinor),
              overQuantityReason: change.overQuantityReason,
            })),
            valueChangeMinor: minorOf(variation.valueChangeMinor),
          });
          if (input.digest !== variation.digest || stored !== variation.digest)
            throw subcontractConflict(
              "subcontract-variation-stale",
              "The variation is not the one you saw; reload and decide again",
            );
          if (!OPEN_FOR_WORK.includes(row.status as SubcontractStatus))
            throw invalidTransition(row.status);
          await this.checkVariationCaps(tx, access.tenantId, row, variationId);
          const resultingVersion = row.contractVersion + 1;
          await tx.subcontractVariation.update({
            where: { tenantId_id: { tenantId: access.tenantId, id: variationId } },
            data: {
              status: "approved",
              decidedBy: access.userId,
              decidedAt: new Date(),
              resultingVersion,
              version: { increment: 1 },
            },
          });
          const approved = await tx.subcontractVariation.aggregate({
            where: { tenantId: access.tenantId, subcontractId: id, status: "approved" },
            _sum: { valueChangeMinor: true },
          });
          await tx.subcontract.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              contractVersion: resultingVersion,
              currentValueMinor:
                (row.originalValueMinor ?? 0n) + (approved._sum.valueChangeMinor ?? 0n),
              updatedBy: access.userId,
              updatedAt: new Date(),
              version: { increment: 1 },
            },
          });
        }
        await this.scope.audit(
          tx,
          action === "approve"
            ? "subcontract.variation_approved"
            : "subcontract.variation_rejected",
          id,
          { projectId: row.projectId, variationId, number: variation.number },
        );
        return subcontractResponseSchema.parse({ subcontract: await this.detailOf(scope, id) });
      },
      true,
      30_000,
    );
  }

  // Advances -----------------------------------------------------------------------------------

  requestAdvance(
    principal: Principal,
    id: string,
    input: CreateSubcontractAdvanceRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.record(scope, id);
        await this.access.require(scope, row.projectId, SUBCONTRACT_ADVANCE_REQUEST_PERMISSIONS, {
          writable: true,
        });
        await lockSubcontract(tx, access.tenantId, id);
        if (!OPEN_FOR_WORK.includes(row.status as SubcontractStatus))
          throw invalidTransition(row.status);
        const committed = await tx.subcontractAdvance.aggregate({
          where: {
            tenantId: access.tenantId,
            subcontractId: id,
            status: { in: ["requested", "approved", "paid"] },
          },
          _sum: { amountMinor: true },
          _max: { number: true },
        });
        if (
          minorOf(committed._sum.amountMinor ?? 0n) + input.amountMinor >
          minorOf(row.advanceLimitMinor)
        )
          throw subcontractConflict(
            "advance-exceeds-limit",
            "Advances cannot exceed the advance agreed in the subcontract",
          );
        const advanceId = nextId();
        const number = (committed._max.number ?? 0) + 1;
        await tx.subcontractAdvance.create({
          data: {
            id: advanceId,
            tenantId: access.tenantId,
            projectId: row.projectId,
            subcontractId: id,
            number,
            amountMinor: BigInt(input.amountMinor),
            reason: input.reason,
            requestedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "subcontract.advance_requested", advanceId, {
          projectId: row.projectId,
          subcontractId: id,
          number,
        });
        return subcontractResponseSchema.parse({ subcontract: await this.detailOf(scope, id) });
      },
      true,
    );
  }

  /** approve (payments.approve + step-up, not the requester) · reject · cancel (reason). */
  decideAdvance(
    principal: Principal,
    advanceId: string,
    action: "approve" | "reject" | "cancel",
    input: { version: number; reason?: string },
    req: Request,
  ) {
    return this.advanceCommand(
      principal,
      advanceId,
      input.version,
      req,
      async (scope, advance, row) => {
        const { tx, access } = scope;
        const project = await this.access.require(
          scope,
          row.projectId,
          action === "cancel"
            ? [
                ...SUBCONTRACT_ADVANCE_REQUEST_PERMISSIONS,
                ...SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS,
              ]
            : SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS,
          { writable: true, stepUp: action === "approve" },
        );
        const allowed: SubcontractAdvanceStatus[] =
          action === "cancel" ? ["requested", "approved"] : ["requested"];
        if (!allowed.includes(advance.status as SubcontractAdvanceStatus))
          throw invalidTransition(advance.status);
        // A closed subcontract has no certificate left to recover an advance from.
        if (action === "approve" && !OPEN_FOR_WORK.includes(row.status as SubcontractStatus))
          throw invalidTransition(row.status);
        if (action !== "cancel" && advance.requestedBy === access.userId)
          throw makerChecker("The person who asked for an advance cannot decide it");
        if (
          action === "cancel" &&
          advance.requestedBy !== access.userId &&
          !this.access.holds(project, SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS)
        )
          throw new ForbiddenException("Only the requester or an approver can cancel an advance");
        await tx.subcontractAdvance.update({
          where: { tenantId_id: { tenantId: access.tenantId, id: advanceId } },
          data: {
            status:
              action === "approve" ? "approved" : action === "reject" ? "rejected" : "cancelled",
            decidedBy: access.userId,
            decidedAt: new Date(),
            decisionNote: input.reason ?? null,
            version: { increment: 1 },
          },
        });
        return `subcontract.advance_${action === "approve" ? "approved" : action === "reject" ? "rejected" : "cancelled"}`;
      },
    );
  }

  /** Records an approved advance as paid outside PM-Buddy (payments.disburse + step-up). */
  payAdvance(
    principal: Principal,
    advanceId: string,
    input: PaySubcontractAdvanceRequest,
    req: Request,
  ) {
    return this.advanceCommand(
      principal,
      advanceId,
      input.version,
      req,
      async (scope, advance, row) => {
        const { tx, access } = scope;
        await this.access.require(scope, row.projectId, SUBCONTRACT_PAY_PERMISSIONS, {
          writable: true,
          stepUp: true,
        });
        if (advance.status !== "approved") throw invalidTransition(advance.status);
        if (!OPEN_FOR_WORK.includes(row.status as SubcontractStatus))
          throw invalidTransition(row.status);
        if (advance.requestedBy === access.userId || advance.decidedBy === access.userId)
          throw makerChecker("Whoever asked for or approved an advance cannot record its payment");
        if (input.paidOn > nairobiDate())
          throw subcontractConflict(
            "payment-date-invalid",
            "A payment date cannot be in the future",
          );
        await tx.subcontractAdvance.update({
          where: { tenantId_id: { tenantId: access.tenantId, id: advanceId } },
          data: {
            status: "paid",
            paidBy: access.userId,
            paidAt: new Date(),
            paidOn: fromCalendarDate(input.paidOn),
            method: input.method,
            reference: input.reference,
            version: { increment: 1 },
          },
        });
        return "subcontract.advance_paid";
      },
    );
  }

  // Helpers ------------------------------------------------------------------------------------

  async record(scope: Scope, id: string): Promise<SubcontractRecord> {
    const row = await scope.tx.subcontract.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
      include: { supplier: { select: supplierSelect } },
    });
    if (!row) throw new NotFoundException("Subcontract not found");
    return row;
  }

  async detail(scope: Scope, id: string) {
    return subcontractResponseSchema.parse({ subcontract: await this.detailOf(scope, id) });
  }

  private draftEdit(
    principal: Principal,
    id: string,
    version: number,
    req: Request,
    work: (scope: Scope, row: SubcontractRecord) => Promise<void>,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.record(scope, id);
        await this.access.require(scope, row.projectId, SUBCONTRACT_PREPARE_PERMISSIONS, {
          writable: true,
        });
        await lockSubcontract(tx, access.tenantId, id);
        if (row.status !== "draft") throw invalidTransition(row.status);
        if (row.version !== version) throw versionConflict();
        await work(scope, row);
        await tx.subcontract.update({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
          data: { updatedBy: access.userId, updatedAt: new Date(), version: { increment: 1 } },
        });
        return subcontractResponseSchema.parse({ subcontract: await this.detailOf(scope, id) });
      },
      true,
    );
  }

  private advanceCommand(
    principal: Principal,
    advanceId: string,
    version: number,
    req: Request,
    work: (scope: Scope, advance: AdvanceRow, row: SubcontractRecord) => Promise<string>,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const advance = await tx.subcontractAdvance.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: advanceId } },
        });
        if (!advance) throw new NotFoundException("Advance not found");
        await lockSubcontract(tx, access.tenantId, advance.subcontractId);
        const row = await this.record(scope, advance.subcontractId);
        if (advance.version !== version) throw versionConflict();
        const event = await work(scope, advance, row);
        await this.scope.audit(tx, event, advanceId, {
          projectId: row.projectId,
          subcontractId: row.id,
          number: advance.number,
        });
        return subcontractResponseSchema.parse({ subcontract: await this.detailOf(scope, row.id) });
      },
      true,
    );
  }

  private async eligibleSupplier(tx: Tx, tenantId: string, supplierId: string) {
    const supplier = await tx.supplier.findUnique({
      where: { tenantId_id: { tenantId, id: supplierId } },
      select: { isSubcontractor: true, status: true },
    });
    if (!supplier?.isSubcontractor || supplier.status !== "active")
      throw subcontractConflict(
        "subcontractor-not-eligible",
        "Choose an active supplier flagged as a subcontractor",
      );
  }

  private async subcontractors(tx: Tx, tenantId: string) {
    const rows = await tx.supplier.findMany({
      where: { tenantId, isSubcontractor: true, status: "active" },
      select: supplierSelect,
      orderBy: { code: "asc" },
      take: 500,
    });
    return rows.map(supplierRef);
  }

  /** What a BQ item can carry: its quantity in the BQ in force, or 100 for a lump sum. */
  private async capacity(tx: Tx, tenantId: string, projectId: string, lineage: string) {
    const version = await bqInForce(tx, tenantId, projectId);
    const item = version
      ? await tx.bqItem.findUnique({
          where: {
            tenantId_versionId_lineageId: { tenantId, versionId: version.id, lineageId: lineage },
          },
        })
      : null;
    if (!item) return "0";
    const basis = measurementBasis(measurable(item));
    return basis === "quantity" ? trimDecimal(item.quantity!) : basis === "percent" ? "100" : "0";
  }

  /** A new line on the BQ in force: the item's basis, own rate, value and the BQ cap. */
  private async prepareLine(
    tx: Tx,
    tenantId: string,
    projectId: string,
    input: {
      bqItemLineageId: string;
      quantity: string;
      rateMinor: number | null;
      lumpSumMinor: number | null;
      vatTreatment: SubcontractVatTreatment;
      description?: string | null;
      overQuantityReason?: string | null;
    },
    subcontractId: string,
  ) {
    const version = await bqInForce(tx, tenantId, projectId);
    if (!version)
      throw subcontractConflict("bq-not-approved", "The project has no approved BQ yet");
    const item = await tx.bqItem.findUnique({
      where: {
        tenantId_versionId_lineageId: {
          tenantId,
          versionId: version.id,
          lineageId: input.bqItemLineageId,
        },
      },
    });
    if (!item)
      throw subcontractProblem(404, "bq-item-not-found", "BQ item not found in the BQ in force");
    const basis = measurementBasis(measurable(item));
    if (basis === null)
      throw subcontractProblem(
        422,
        "item-not-measurable",
        "Provisional sums, PC sums, contingencies and unpriced items are not let",
      );
    if ((basis === "quantity") !== (input.rateMinor !== null))
      throw subcontractProblem(
        422,
        "item-not-measurable",
        basis === "quantity"
          ? "Give a rate per unit for an item measured by quantity"
          : "Give a lump sum for a share of a lump-sum item",
      );
    if (basis === "percent" && scaled(input.quantity, 4) > 1_000_000n)
      throw subcontractProblem(422, "subcontract-rule", "A lump-sum share cannot pass 100 %");
    const lets = await projectLets(tx, tenantId, projectId);
    const check = checkLineAgainstBq({
      bqQuantity: basis === "quantity" ? trimDecimal(item.quantity!) : "100",
      others: letOn(lets, item.lineageId, subcontractId),
      quantity: input.quantity,
      exceptionReason: input.overQuantityReason,
    });
    if (!check.ok)
      throw subcontractProblem(
        409,
        "over-bq-quantity",
        `Only ${check.availableQuantity} is left to let on this BQ item; give a reason to let more`,
        { availableQuantity: check.availableQuantity },
      );
    return {
      bqVersionId: version.id,
      bqItemLineageId: item.lineageId,
      basis,
      description: input.description ?? item.description.slice(0, 500),
      unit: basis === "percent" ? "%" : item.unit,
      quantity: input.quantity,
      rateMinor: input.rateMinor === null ? null : BigInt(input.rateMinor),
      amountMinor: BigInt(
        subcontractLineAmountMinor(basis, input.quantity, input.rateMinor, input.lumpSumMinor),
      ),
      vatTreatment: input.vatTreatment,
      overQuantityReason: check.over ? (input.overQuantityReason ?? null) : null,
    };
  }

  /** Lines' latest claimed quantity to date (submitted or certified certificates). */
  private async claimedLines(tx: Tx, tenantId: string, subcontractId: string) {
    const latest = await tx.subcontractCertificate.findFirst({
      where: { tenantId, subcontractId, status: { in: ["submitted", "certified"] } },
      orderBy: { number: "desc" },
      select: { id: true, revision: true },
    });
    const result = new Map<string, string>();
    if (!latest) return result;
    for (const line of await tx.subcontractCertificateLine.findMany({
      where: { tenantId, certificateId: latest.id, revision: latest.revision },
    }))
      result.set(line.lineId, trimDecimal(line.quantityToDate));
    return result;
  }

  /** The API's copy of the database cap check for a variation about to be approved. */
  private async checkVariationCaps(
    tx: Tx,
    tenantId: string,
    row: SubcontractRecord,
    variationId: string,
  ) {
    const lines = await linesOf(tx, tenantId, row.id);
    const changes = await tx.subcontractLineChange.findMany({ where: { tenantId, variationId } });
    const lets = await projectLets(tx, tenantId, row.projectId);
    const touched = lines.filter(
      (line) =>
        line.row.variationId === variationId ||
        changes.some((change) => change.lineId === line.row.id),
    );
    for (const line of touched) {
      const change = changes.find((entry) => entry.lineId === line.row.id);
      const quantity = change
        ? sumQuantities([line.quantity, trimDecimal(change.quantityChange)])
        : line.quantity;
      const check = checkLineAgainstBq({
        bqQuantity: await this.capacity(tx, tenantId, row.projectId, line.row.bqItemLineageId),
        others: letOn(lets, line.row.bqItemLineageId, row.id),
        quantity,
        exceptionReason: change?.overQuantityReason ?? line.row.overQuantityReason,
      });
      if (!check.ok)
        throw subcontractConflict(
          "over-bq-quantity",
          `The BQ item would be let above its quantity (${line.row.bqItem.ref ?? ""})`,
        );
    }
  }

  /**
   * What blocks submission or approval now, the value of the contract lines and the digest an
   * approver quotes (terms and lines as submitted).
   */
  private async readiness(tx: Tx, tenantId: string, row: SubcontractRecord) {
    const lines = (await linesOf(tx, tenantId, row.id)).filter(
      (line) => line.row.variationId === null,
    );
    const problems: Problem[] = [];
    if (!lines.length) problems.push({ code: "subcontract-empty", ref: null });
    const supplier = await tx.supplier.findUnique({
      where: { tenantId_id: { tenantId, id: row.supplierId } },
      select: { isSubcontractor: true, status: true },
    });
    if (!supplier?.isSubcontractor || supplier.status !== "active")
      problems.push({ code: "subcontractor-not-eligible", ref: null });
    const lets = await projectLets(tx, tenantId, row.projectId);
    const version = await bqInForce(tx, tenantId, row.projectId);
    for (const line of lines) {
      if (version && line.row.bqVersionId !== version.id && row.status === "draft")
        problems.push({ code: "bq-not-approved", ref: line.row.bqItem.ref });
      const check = checkLineAgainstBq({
        bqQuantity: await this.capacity(tx, tenantId, row.projectId, line.row.bqItemLineageId),
        others: letOn(lets, line.row.bqItemLineageId, row.id),
        quantity: line.quantity,
        exceptionReason: line.row.overQuantityReason,
      });
      if (!check.ok) problems.push({ code: "over-bq-quantity", ref: line.row.bqItem.ref });
    }
    const valueMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
    if (
      !advanceRecoverable(
        minorOf(row.advanceLimitMinor),
        valueMinor,
        trimDecimal(row.advanceRecoveryPercent),
      )
    )
      problems.push({ code: "advance-not-recoverable", ref: null });
    const digest = requestDigest("subcontract", {
      subcontractId: row.id,
      supplierId: row.supplierId,
      kind: row.kind,
      title: row.title,
      scope: row.scope,
      startDate: toCalendarDate(row.startDate),
      endDate: toCalendarDate(row.endDate),
      terms: {
        retentionPercent: trimDecimal(row.retentionPercent),
        retentionLimitPercent: decimalOrNull(row.retentionLimitPercent),
        practicalReleasePercent: trimDecimal(row.practicalReleasePercent),
        vatPercent: trimDecimal(row.vatPercent),
        whtPercent: trimDecimal(row.whtPercent),
        advanceLimitMinor: minorOf(row.advanceLimitMinor),
        advanceRecoveryPercent: trimDecimal(row.advanceRecoveryPercent),
        paymentTermsDays: row.paymentTermsDays,
        paymentTermsNote: row.paymentTermsNote,
      },
      lines: lines.map((line) => ({
        id: line.row.id,
        lineage: line.row.bqItemLineageId,
        quantity: line.quantity,
        rateMinor: line.terms.rateMinor,
        amountMinor: line.amountMinor,
        vatTreatment: line.row.vatTreatment,
        overQuantityReason: line.row.overQuantityReason,
      })),
      valueMinor,
    });
    return { problems, valueMinor, digest };
  }

  /** Summaries with each subcontract's position (statement figures) and open commitment. */
  private async summaries(
    tx: Tx,
    tenantId: string,
    rows: SubcontractRecord[],
    project: ProjectAccess,
  ): Promise<SubcontractSummary[]> {
    const result: SubcontractSummary[] = [];
    for (const row of rows) {
      const facts = await subcontractFacts(tx, tenantId, row);
      result.push(this.summaryOf(row, project, facts));
    }
    return result;
  }

  private summaryOf(
    row: SubcontractRecord,
    project: ProjectAccess,
    facts: SubcontractFacts,
  ): SubcontractSummary {
    const open = facts.certificates.find(
      (entry) => entry.status === "draft" || entry.status === "submitted",
    );
    return {
      id: row.id,
      number: row.number,
      code: codes.subcontract(row.number),
      project: projectRef(project.project),
      supplier: supplierRef(row.supplier),
      kind: row.kind as SubcontractKind,
      title: row.title,
      status: row.status as SubcontractStatus,
      startDate: toCalendarDate(row.startDate),
      endDate: toCalendarDate(row.endDate),
      contractVersion: row.contractVersion,
      valueMinor:
        row.currentValueMinor === null
          ? facts.lines
              .filter((line) => line.row.variationId === null)
              .reduce((sum, line) => sum + line.amountMinor, 0)
          : minorOf(row.currentValueMinor),
      originalValueMinor: row.originalValueMinor === null ? null : minorOf(row.originalValueMinor),
      committedMinor: facts.committedMinor,
      position: facts.position,
      openCertificate: open
        ? {
            id: open.id,
            number: open.number,
            code: codes.certificate(open.number, false),
            status: open.status as SubcontractCertificateStatus,
          }
        : null,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async detailOf(scope: Scope, id: string): Promise<SubcontractDetail> {
    const { tx, access } = scope;
    const row = await this.record(scope, id);
    const project = await this.access.reader(scope, row.projectId);
    const facts = await subcontractFacts(tx, access.tenantId, row);
    const today = nairobiDate();
    const [lets, measured, version, variations, changes] = await Promise.all([
      projectLets(tx, access.tenantId, row.projectId),
      measuredAt(tx, access.tenantId, row.projectId, today),
      bqInForce(tx, access.tenantId, row.projectId),
      tx.subcontractVariation.findMany({
        where: { tenantId: access.tenantId, subcontractId: id },
        orderBy: { number: "desc" },
        take: SUBCONTRACT_LIMITS.historySize,
      }),
      tx.subcontractLineChange.findMany({
        where: { tenantId: access.tenantId, subcontractId: id },
      }),
    ]);
    const items = version
      ? await tx.bqItem.findMany({
          where: {
            tenantId: access.tenantId,
            versionId: version.id,
            lineageId: { in: facts.lines.map((line) => line.row.bqItemLineageId) },
          },
        })
      : [];
    const itemOf = new Map(items.map((item) => [item.lineageId, item]));
    const readiness =
      row.status === "draft" || row.status === "submitted"
        ? await this.readiness(tx, access.tenantId, row)
        : null;
    const people = await peopleOf(tx, [
      row.createdBy,
      row.submittedBy,
      row.approvedBy,
      row.activatedBy,
      row.closedBy,
      row.cancelledBy,
      ...variations.flatMap((entry) => [entry.createdBy, entry.decidedBy]),
      ...facts.advances.flatMap((entry) => [entry.requestedBy, entry.decidedBy, entry.paidBy]),
    ]);
    const prepare = this.access.can(project, SUBCONTRACT_PREPARE_PERMISSIONS);
    const approve = this.access.can(project, SUBCONTRACT_APPROVE_PERMISSIONS);
    const status = row.status as SubcontractStatus;
    const open = facts.certificates.some(
      (entry) => entry.status === "draft" || entry.status === "submitted",
    );
    const pendingVariation = variations.some((entry) => entry.status === "pending");
    const warnings: Problem[] = [];
    const lines = facts.lines.map((line) => {
      const item = itemOf.get(line.row.bqItemLineageId) ?? null;
      // Compared exactly: rate (minor) × 100 against the BQ rate scaled to four places; a lump
      // sum against the same share of the item's amount.
      const rateAboveBq =
        item === null
          ? false
          : line.row.basis === "quantity"
            ? item.rate !== null &&
              line.terms.rateMinor !== null &&
              BigInt(line.terms.rateMinor) * 100n > scaled(item.rate.toFixed(), 4)
            : BigInt(line.amountMinor) * 1_000_000n >
              BigInt(minorOf(item.amountMinor)) * scaled(line.quantity, 4);
      if (rateAboveBq) warnings.push({ code: "rate-above-bq", ref: line.row.bqItem.ref });
      const certified = facts.certified.get(line.row.id);
      return {
        id: line.row.id,
        lineNo: line.row.lineNo,
        bqItem: itemWire(line.row.bqItem),
        basis: line.row.basis as SubcontractLineBasis,
        description: line.row.description,
        unit: line.row.unit,
        quantity: line.quantity,
        originalQuantity: trimDecimal(line.row.quantity),
        rateMinor: line.terms.rateMinor,
        amountMinor: line.amountMinor,
        vatTreatment: line.row.vatTreatment as SubcontractVatTreatment,
        overQuantityReason: line.row.overQuantityReason,
        addedBy: line.row.variation
          ? {
              id: line.row.variation.id,
              code: codes.variation(line.row.variation.number),
              status: line.row.variation.status as SubcontractVariationStatus,
            }
          : null,
        inForce: line.inForce,
        bqQuantity: item ? decimalOrNull(item.quantity) : null,
        bqRate: item ? decimalOrNull(item.rate) : null,
        rateAboveBq,
        letElsewhere: letOn(lets, line.row.bqItemLineageId, row.id),
        measuredToDate: measured.get(line.row.bqItemLineageId)?.quantity ?? "0",
        certifiedQuantity: certified?.quantity ?? "0",
        certifiedMinor: certified?.valueMinor ?? 0,
      };
    });
    const summary = this.summaryOf(row, project, facts);
    return {
      ...summary,
      scope: row.scope,
      terms: {
        retentionPercent: trimDecimal(row.retentionPercent),
        retentionLimitPercent: percentText(decimalOrNull(row.retentionLimitPercent)),
        practicalReleasePercent: trimDecimal(row.practicalReleasePercent),
        vatPercent: trimDecimal(row.vatPercent),
        whtPercent: trimDecimal(row.whtPercent),
        advanceLimitMinor: minorOf(row.advanceLimitMinor),
        advanceRecoveryPercent: trimDecimal(row.advanceRecoveryPercent),
        paymentTermsDays: row.paymentTermsDays,
        paymentTermsNote: row.paymentTermsNote,
      },
      digest: row.digest,
      currentDigest: readiness?.digest ?? row.digest ?? requestDigest("subcontract", { id }),
      createdBy: personOf(people, row.createdBy),
      createdAt: row.createdAt.toISOString(),
      submittedBy: maybePerson(people, row.submittedBy),
      submittedAt: row.submittedAt?.toISOString() ?? null,
      approvedBy: maybePerson(people, row.approvedBy),
      approvedAt: row.approvedAt?.toISOString() ?? null,
      activatedBy: maybePerson(people, row.activatedBy),
      activatedAt: row.activatedAt?.toISOString() ?? null,
      closedBy: maybePerson(people, row.closedBy),
      closedAt: row.closedAt?.toISOString() ?? null,
      closeReason: row.closeReason,
      cancelledBy: maybePerson(people, row.cancelledBy),
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelReason: row.cancelReason,
      returnReason: row.returnReason,
      lines,
      variations: variations.map((entry) => ({
        id: entry.id,
        number: entry.number,
        code: codes.variation(entry.number),
        reason: entry.reason,
        status: entry.status as SubcontractVariationStatus,
        valueChangeMinor: minorOf(entry.valueChangeMinor),
        digest: entry.digest,
        resultingVersion: entry.resultingVersion,
        additions: facts.lines
          .filter((line) => line.row.variationId === entry.id)
          .map((line) => line.row.id),
        changes: changes
          .filter((change) => change.variationId === entry.id)
          .map((change) => ({
            lineId: change.lineId,
            lineNo: facts.lines.find((line) => line.row.id === change.lineId)?.row.lineNo ?? 0,
            quantityChange: trimDecimal(change.quantityChange),
            amountChangeMinor: minorOf(change.amountChangeMinor),
            overQuantityReason: change.overQuantityReason,
          })),
        createdBy: personOf(people, entry.createdBy),
        createdAt: entry.createdAt.toISOString(),
        decidedBy: maybePerson(people, entry.decidedBy),
        decidedAt: entry.decidedAt?.toISOString() ?? null,
        decisionReason: entry.decisionReason,
        version: entry.version,
        permissions: {
          canApprove:
            approve &&
            entry.status === "pending" &&
            entry.createdBy !== access.userId &&
            OPEN_FOR_WORK.includes(status),
          canReject: approve && entry.status === "pending" && entry.createdBy !== access.userId,
        },
      })),
      advances: facts.advances.map((entry) => ({
        id: entry.id,
        number: entry.number,
        code: codes.advance(entry.number),
        amountMinor: minorOf(entry.amountMinor),
        reason: entry.reason,
        status: entry.status as SubcontractAdvanceStatus,
        requestedBy: personOf(people, entry.requestedBy),
        requestedAt: entry.requestedAt.toISOString(),
        decidedBy: maybePerson(people, entry.decidedBy),
        decidedAt: entry.decidedAt?.toISOString() ?? null,
        decisionNote: entry.decisionNote,
        paidBy: maybePerson(people, entry.paidBy),
        paidAt: entry.paidAt?.toISOString() ?? null,
        paidOn: entry.paidOn ? toCalendarDate(entry.paidOn) : null,
        method: (entry.method as SubcontractPaymentMethod | null) ?? null,
        reference: entry.reference,
        version: entry.version,
        permissions: {
          canApprove:
            this.access.can(project, SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS) &&
            entry.status === "requested" &&
            entry.requestedBy !== access.userId,
          canReject:
            this.access.can(project, SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS) &&
            entry.status === "requested" &&
            entry.requestedBy !== access.userId,
          canPay:
            this.access.can(project, SUBCONTRACT_PAY_PERMISSIONS) &&
            entry.status === "approved" &&
            entry.requestedBy !== access.userId &&
            entry.decidedBy !== access.userId,
          canCancel:
            (entry.status === "requested" || entry.status === "approved") &&
            ((entry.requestedBy === access.userId &&
              this.access.can(project, SUBCONTRACT_ADVANCE_REQUEST_PERMISSIONS)) ||
              this.access.can(project, SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS)),
        },
      })),
      certificates: facts.certificates.map((entry) => ({
        id: entry.id,
        number: entry.number,
        code: codes.certificate(
          entry.certificateNumber ?? entry.number,
          entry.certificateNumber !== null,
        ),
        certificateNumber: entry.certificateNumber,
        kind: entry.kind as SubcontractCertificateKind,
        releaseStage: (entry.releaseStage as ReleaseStage | null) ?? null,
        status: entry.status as SubcontractCertificateStatus,
        valuationDate: toCalendarDate(entry.valuationDate),
        workDoneMinor: entry.workDoneMinor === null ? null : minorOf(entry.workDoneMinor),
        amountDueMinor: entry.amountDueMinor === null ? null : minorOf(entry.amountDueMinor),
        payableMinor: entry.payableMinor === null ? null : minorOf(entry.payableMinor),
        paidMinor: facts.paidByCertificate.get(entry.id) ?? 0,
        certifiedAt: entry.certifiedAt?.toISOString() ?? null,
      })),
      problems: readiness?.problems ?? [],
      warnings,
      permissions: {
        canEdit: prepare && status === "draft",
        canSubmit: prepare && status === "draft",
        canApprove: approve && status === "submitted" && !row.contributors.includes(access.userId),
        canReturn: approve && status === "submitted",
        canActivate: (prepare || approve) && status === "approved",
        canComplete: (prepare || approve) && status === "active" && !open && !pendingVariation,
        canTerminate: approve && OPEN_FOR_WORK.includes(status) && !open && !pendingVariation,
        canCancel: (prepare || approve) && (status === "draft" || status === "submitted"),
        canVary: prepare && OPEN_FOR_WORK.includes(status) && !pendingVariation,
        canRequestAdvance:
          this.access.can(project, SUBCONTRACT_ADVANCE_REQUEST_PERMISSIONS) &&
          OPEN_FOR_WORK.includes(status) &&
          minorOf(row.advanceLimitMinor) > 0,
        canCreateCertificate:
          prepare &&
          !open &&
          (status === "active" || status === "completed" || status === "terminated"),
        canExport: true,
      },
    };
  }
}

const actionEvent = {
  submit: "submitted",
  approve: "approved",
  return: "returned",
  activate: "activated",
  complete: "completed",
  terminate: "terminated",
  cancel: "cancelled",
} as const;

const PROBLEM_TEXT: Record<string, string> = {
  "subcontract-empty": "Add at least one line first",
  "subcontractor-not-eligible": "Choose an active supplier flagged as a subcontractor",
  "over-bq-quantity": "A line takes its BQ item above the BQ quantity; give a reason",
  "advance-not-recoverable": "The advance cannot be recovered by the recovery percentage",
  "bq-not-approved": "A line names an item of an older BQ version; remove and add it again",
};
const problemText = (code: string) => PROBLEM_TEXT[code] ?? "This cannot be submitted yet";

const maybePerson = (people: People, id: string | null) => (id ? personOf(people, id) : null);

export type SubcontractFacts = Awaited<ReturnType<typeof subcontractFacts>>;

/**
 * The statement figures of one subcontract: certified certificates (work, due, VAT, WHT,
 * payable), recorded payments, retention held and advances (paid, recovered, outstanding), and
 * the open commitment = Σ over live lines of (value in force − value certified), never below 0.
 */
export async function subcontractFacts(
  tx: Tx,
  tenantId: string,
  row: { id: string; status: string },
) {
  const [lines, certified, certificates, advances, payments] = await Promise.all([
    linesOf(tx, tenantId, row.id),
    lastCertifiedLines(tx, tenantId, row.id),
    tx.subcontractCertificate.findMany({
      where: { tenantId, subcontractId: row.id },
      orderBy: { number: "desc" },
      take: SUBCONTRACT_LIMITS.historySize,
    }),
    tx.subcontractAdvance.findMany({
      where: { tenantId, subcontractId: row.id },
      orderBy: { number: "desc" },
      take: SUBCONTRACT_LIMITS.historySize,
    }),
    tx.subcontractPayment.groupBy({
      by: ["certificateId"],
      where: { tenantId, subcontractId: row.id },
      _sum: { amountMinor: true },
    }),
  ]);
  const paidByCertificate = new Map(
    payments.map((entry) => [entry.certificateId, minorOf(entry._sum.amountMinor ?? 0n)]),
  );
  const done = certificates.filter((entry) => entry.status === "certified");
  const last = [...done].sort((a, b) => (b.certificateNumber ?? 0) - (a.certificateNumber ?? 0))[0];
  const sum = (pick: (entry: (typeof done)[number]) => bigint | null) =>
    done.reduce((total, entry) => total + minorOf(pick(entry) ?? 0n), 0);
  const payableMinor = sum((entry) => entry.payableMinor);
  const paidMinor = [...paidByCertificate.values()].reduce((total, value) => total + value, 0);
  const advancesPaidMinor = advances
    .filter((entry) => entry.status === "paid")
    .reduce((total, entry) => total + minorOf(entry.amountMinor), 0);
  const advancesRecoveredMinor = last ? minorOf(last.recoveredToDateMinor ?? 0n) : 0;
  const live = row.status === "approved" || row.status === "active";
  const committedMinor = live
    ? lines
        .filter((line) => line.inForce)
        .reduce(
          (total, line) =>
            total + Math.max(0, line.amountMinor - (certified.get(line.row.id)?.valueMinor ?? 0)),
          0,
        )
    : 0;
  const position: SubcontractPosition = {
    certifiedWorkMinor: last ? minorOf(last.workDoneMinor ?? 0n) : 0,
    certifiedDueMinor: sum((entry) => entry.amountDueMinor),
    vatMinor: sum((entry) => entry.vatMinor),
    whtMinor: sum((entry) => entry.whtMinor),
    payableMinor,
    paidMinor,
    outstandingMinor: payableMinor - paidMinor,
    retentionHeldMinor: last ? minorOf(last.retentionHeldMinor ?? 0n) : 0,
    advancesPaidMinor,
    advancesRecoveredMinor,
    advancesOutstandingMinor: advancesPaidMinor - advancesRecoveredMinor,
  };
  return {
    lines,
    certified,
    certificates,
    advances,
    paidByCertificate,
    committedMinor,
    position,
  };
}

export type { LineInForce };
