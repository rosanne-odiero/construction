import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  allowedVariationActions,
  applyVariation,
  BQ_UNIT_LABELS,
  checkVariationTransition,
  isProjectReadOnly,
  priceVariationLine,
  priceVariationLines,
  projectedTotals,
  variationTotals,
  type PricedLine,
  type VariationLineInput,
  type VersionContent,
} from "@pm-buddy/domain";
import type {
  BqUnit,
  ProjectStatus,
  VariationAction,
  VariationAddKind,
  VariationLineAction,
  VariationLineIssue,
  VariationStatus,
} from "@pm-buddy/types";
import {
  variationResponseSchema,
  variationsResponseSchema,
  type CreateVariationRequest,
  type SaveVariationLinesRequest,
  type UpdateVariationRequest,
  type VariationDetail,
  type VariationSummary,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { BqAccess, bqBadRequest, bqConflict, bqProblem, recordConflict } from "./bq-access.js";
import { loadContent } from "./bq-content.js";
import { peopleOf, personOf, safeMinor, type BqVersionRow } from "./bq-mappers.js";
import { BqVersionWriter } from "./bq-version-writer.js";
import { latestApproved, versionsOf } from "./bq-versions.service.js";
import { InstructionsService } from "./instructions.service.js";
import { variationDigest } from "./variation-digest.js";

type Tx = Prisma.TransactionClient;
type VariationRow = Prisma.VariationOrderGetPayload<object>;
type LineRow = Prisma.VariationLineGetPayload<object>;

const APPROVE_TIMEOUT_MS = 60_000;
const decimal = (value: Prisma.Decimal | null) => (value === null ? null : value.toFixed());
const minor = (value: bigint | null) => (value === null ? null : safeMinor(value));

/** A stored line as the domain sees it. */
function toInput(row: LineRow): VariationLineInput {
  return {
    action: row.action as VariationLineAction,
    itemLineageId: row.itemLineageId,
    billLineageId: row.billLineageId,
    sectionLineageId: row.sectionLineageId,
    newSection: row.newSectionTitle
      ? { code: row.newSectionCode, title: row.newSectionTitle }
      : null,
    newLineageId: row.newLineageId,
    ref: row.ref,
    description: row.description,
    unit: row.unit as BqUnit | null,
    unitRaw: row.unitRaw,
    kind: row.kind as VariationAddKind | null,
    quantity: decimal(row.quantity),
    rate: decimal(row.rate),
    amountMinor: minor(row.amountMinor),
    note: row.note,
  };
}

const lineIssue = (code: VariationLineIssue, index: number) =>
  `Line ${index + 1}: ${code.replace(/-/g, " ")}`;

/**
 * Variation Orders (D2.3, docs/WORKFLOWS.md Variation): drafted against the newest approved BQ
 * version and an open instruction (bq.edit); submission freezes a snapshot digest; approval
 * (bq.approve_variation, fresh step-up, someone other than the creator or submitter, the digest
 * the approver saw) creates the next BQ version in one transaction; a variation whose base is no
 * longer the newest approved version is stale until rebased. Mutations lock the company row
 * (TenantScope) and then the BQ row, so approvals for one BQ run one at a time; the database
 * repeats the state machine and the one-child-per-version rule.
 */
/**
 * Maker-checker by identity: whoever raised, edited, reopened, rebased or submitted the proposal
 * (the `contributors` list the database keeps) may not decide on it.
 */
const isVariationMaker = (
  row: { createdBy: string; submittedBy: string | null; contributors: string[] },
  userId: string,
): boolean =>
  userId === row.createdBy || userId === row.submittedBy || row.contributors.includes(userId);

@Injectable()
export class VariationsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: BqAccess,
    private readonly writer: BqVersionWriter,
  ) {}

  // Reading -----------------------------------------------------------------------------------

  list(principal: Principal, projectId: string, query: { status?: string }, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const { project, effective } = await this.access.load(scope, projectId, "bq.view");
      const readOnly = isProjectReadOnly(project.status as ProjectStatus);
      const found = await versionsOf(tx, access.tenantId, projectId);
      const rows = found
        ? await tx.variationOrder.findMany({
            where: {
              tenantId: access.tenantId,
              bqId: found.bq.id,
              ...(query.status ? { status: query.status } : {}),
            },
            orderBy: { number: "desc" },
          })
        : [];
      const summaries = await this.summaries(scope, rows, found?.versions ?? []);
      const canCreate = effective.has("bq.edit") && !readOnly;
      return variationsResponseSchema.parse({
        variations: summaries,
        permissions: { canCreate, canApprove: effective.has("bq.approve_variation") && !readOnly },
        createBlocker: readOnly
          ? "read-only"
          : !effective.has("bq.edit")
            ? "permission"
            : !found || !latestApproved(found.versions)
              ? "no-baseline"
              : null,
      });
    });
  }

  get(principal: Principal, projectId: string, variationId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { project, effective } = await this.access.load(scope, projectId, "bq.view");
      const row = await this.row(scope, projectId, variationId);
      return this.detail(scope, row, project.status as ProjectStatus, effective);
    });
  }

  private async row(scope: Scope, projectId: string, variationId: string) {
    const row = await scope.tx.variationOrder.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: variationId } },
    });
    if (!row || row.projectId !== projectId) throw new NotFoundException("Variation not found");
    return row;
  }

  private async summaries(
    scope: Scope,
    rows: VariationRow[],
    versions: readonly BqVersionRow[],
  ): Promise<VariationSummary[]> {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const latest = latestApproved(versions);
    const byId = new Map(versions.map((version) => [version.id, version]));
    const results = new Map(
      versions.flatMap((version) => (version.variationId ? [[version.variationId, version]] : [])),
    );
    const [people, instructions] = await Promise.all([
      peopleOf(
        tx,
        rows.map((row) => row.createdBy),
      ),
      tx.instruction.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.instructionId) } },
        select: { id: true, number: true, subject: true },
      }),
    ]);
    const instructionOf = new Map(instructions.map((entry) => [entry.id, entry]));
    return rows.map((row) => {
      const base = byId.get(row.baseVersionId)!;
      const result = results.get(row.id) ?? null;
      const effect = projectedTotals(
        {
          subtotalMinor: safeMinor(base.subtotalMinor),
          grandTotalMinor: safeMinor(base.grandTotalMinor),
        },
        safeMinor(row.netMinor),
        base.vatRatePercent.toFixed(),
      ).grandTotalEffectMinor;
      return {
        id: row.id,
        number: row.number,
        title: row.title,
        status: row.status as VariationStatus,
        instruction: instructionOf.get(row.instructionId)!,
        baseVersion: { id: base.id, versionNo: base.versionNo },
        resultVersion: result ? { id: result.id, versionNo: result.versionNo } : null,
        totals: {
          additionsMinor: safeMinor(row.additionsMinor),
          omissionsMinor: safeMinor(row.omissionsMinor),
          netMinor: safeMinor(row.netMinor),
        },
        grandTotalEffectMinor: effect,
        lineCount: row.lineCount,
        stale:
          ["draft", "submitted", "rejected"].includes(row.status) &&
          latest?.id !== row.baseVersionId,
        createdBy: personOf(people, row.createdBy),
        createdAt: row.createdAt.toISOString(),
        submittedAt: row.submittedAt?.toISOString() ?? null,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        version: row.version,
      };
    });
  }

  private async detail(
    scope: Scope,
    row: VariationRow,
    projectStatus: ProjectStatus,
    effective: ReadonlySet<string>,
  ) {
    const { tx, access } = scope;
    const found = (await versionsOf(tx, access.tenantId, row.projectId))!;
    const [summary] = await this.summaries(scope, [row], found.versions);
    const base = found.versions.find((version) => version.id === row.baseVersionId)!;
    const latest = latestApproved(found.versions)!;
    const [lines, content, history] = await Promise.all([
      tx.variationLine.findMany({
        where: { tenantId: access.tenantId, variationId: row.id },
        orderBy: { lineNo: "asc" },
      }),
      loadContent(tx, access.tenantId, base.id),
      tx.variationStatusChange.findMany({
        where: { tenantId: access.tenantId, variationId: row.id },
        orderBy: { changedAt: "asc" },
      }),
    ]);
    const people = await peopleOf(tx, [
      row.submittedBy,
      row.decidedBy,
      ...history.map((entry) => entry.changedBy),
    ]);
    const issues = this.issues(row, lines, content);
    const readOnly = isProjectReadOnly(projectStatus);
    const status = row.status as VariationStatus;
    const maker = isVariationMaker(row, access.userId);
    const stale = summary!.stale;
    const actions = allowedVariationActions(status).filter((action) => {
      if (readOnly) return false;
      if (action === "approve" || action === "reject")
        return effective.has("bq.approve_variation") && !maker && (action === "reject" || !stale);
      if (action === "rebase") return effective.has("bq.edit") && stale;
      return effective.has("bq.edit");
    });
    const approvalBlocker =
      status !== "submitted"
        ? "status"
        : readOnly
          ? "read-only"
          : !effective.has("bq.approve_variation")
            ? "permission"
            : maker
              ? "maker"
              : stale
                ? "stale"
                : null;
    const projected = projectedTotals(
      {
        subtotalMinor: safeMinor(base.subtotalMinor),
        grandTotalMinor: safeMinor(base.grandTotalMinor),
      },
      safeMinor(row.netMinor),
      base.vatRatePercent.toFixed(),
    );
    const bills = new Map(content.bills.map((bill) => [bill.lineageId, bill]));
    const sections = new Map(content.sections.map((section) => [section.lineageId, section]));
    const items = new Map(content.items.map((item) => [item.lineageId, item]));
    const detail: VariationDetail = {
      ...summary!,
      description: row.description,
      lines: lines.map((line, index) => {
        const item = line.itemLineageId ? items.get(line.itemLineageId) : undefined;
        const bill = bills.get(item?.billLineageId ?? line.billLineageId ?? "");
        const section = sections.get(item?.sectionLineageId ?? line.sectionLineageId ?? "");
        return {
          id: line.id,
          lineNo: line.lineNo,
          action: line.action as VariationLineAction,
          itemLineageId: line.itemLineageId,
          billLineageId: line.billLineageId,
          sectionLineageId: line.sectionLineageId,
          newSection: line.newSectionTitle
            ? { code: line.newSectionCode, title: line.newSectionTitle }
            : null,
          newLineageId: line.newLineageId,
          ref: line.ref,
          description: line.description,
          unit: line.unit as BqUnit | null,
          kind: line.kind as VariationAddKind | null,
          quantity: decimal(line.quantity),
          rate: decimal(line.rate),
          amountMinor: minor(line.amountMinor),
          note: line.note,
          baseAmountMinor: safeMinor(line.baseAmountMinor),
          newAmountMinor: safeMinor(line.newAmountMinor),
          deltaMinor: safeMinor(line.deltaMinor),
          issue: issues[index] ?? null,
          target: {
            billNumber: bill?.number ?? "",
            billTitle: bill?.title ?? "",
            sectionTitle: section?.title ?? line.newSectionTitle ?? null,
            // For an added item: what the line adds.
            ref: item ? item.ref : line.ref,
            description: item ? item.description : line.description,
            unit: (item ? item.unit : line.unit) as BqUnit | null,
            unitRaw: item ? item.unitRaw : line.unitRaw,
            quantity: item?.quantity ?? null,
            rate: item?.rate ?? null,
            amountSource: item?.amountSource ?? null,
          },
        };
      }),
      baseTotals: {
        subtotalMinor: safeMinor(base.subtotalMinor),
        vatMinor: safeMinor(base.vatMinor),
        grandTotalMinor: safeMinor(base.grandTotalMinor),
      },
      projected: {
        subtotalMinor: projected.subtotalMinor,
        vatMinor: projected.vatMinor,
        grandTotalMinor: projected.grandTotalMinor,
      },
      vatRatePercent: base.vatRatePercent.toFixed(),
      latestVersion: { id: latest.id, versionNo: latest.versionNo },
      snapshot:
        row.snapshotDigest && row.submittedAt && row.submittedBy
          ? {
              digest: row.snapshotDigest,
              submittedAt: row.submittedAt.toISOString(),
              submittedBy: personOf(people, row.submittedBy),
            }
          : null,
      decision:
        (status === "approved" || status === "rejected") && row.decidedBy && row.decidedAt
          ? {
              outcome: status,
              by: personOf(people, row.decidedBy),
              at: row.decidedAt.toISOString(),
              reason: row.decisionReason,
            }
          : null,
      cancelReason: row.cancelReason,
      history: history.map((entry) => ({
        from: entry.fromStatus as VariationStatus | null,
        to: entry.toStatus as VariationStatus,
        action: entry.action as VariationAction | "create",
        reason: entry.reason,
        by: personOf(people, entry.changedBy),
        at: entry.changedAt.toISOString(),
      })),
      permissions: {
        canEdit: status === "draft" && effective.has("bq.edit") && !readOnly,
        actions,
        approvalBlocker,
      },
    };
    return variationResponseSchema.parse({ variation: detail });
  }

  /** Per-line issues against the current base (drafts only; frozen proposals were checked). */
  private issues(
    row: VariationRow,
    lines: LineRow[],
    content: VersionContent,
  ): (VariationLineIssue | null)[] {
    if (row.status !== "draft") return lines.map(() => null);
    return lines.map((line) => {
      const result = priceVariationLine(toInput(line), content);
      if (!result.ok) return result.error;
      return result.priced.noChange ? "line-no-change" : null;
    });
  }

  // Writing -----------------------------------------------------------------------------------

  private async statusChange(
    tx: Tx,
    row: VariationRow,
    change: {
      from: string | null;
      to: string;
      action: string;
      reason?: string | null;
      digest?: string | null;
    },
    userId: string,
  ) {
    await tx.variationStatusChange.create({
      data: {
        id: uuidv7(),
        tenantId: row.tenantId,
        variationId: row.id,
        fromStatus: change.from,
        toStatus: change.to,
        action: change.action,
        reason: change.reason ?? null,
        snapshotDigest: change.digest ?? null,
        changedBy: userId,
      },
    });
  }

  private async nextNumber(tx: Tx, tenantId: string, projectId: string) {
    const rows = await tx.variationOrder.findMany({
      where: { tenantId, projectId },
      select: { number: true },
    });
    const highest = rows.reduce((max, { number }) => {
      const match = /^VO-(\d{3,10})$/.exec(number);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `VO-${String(highest + 1).padStart(3, "0")}`;
  }

  private assertTransition(
    row: VariationRow,
    action: VariationAction,
    options: { reason?: string | null; stale?: boolean } = {},
  ) {
    const check = checkVariationTransition({
      status: row.status as VariationStatus,
      action,
      reason: options.reason,
      stale: options.stale,
    });
    if (check.ok) return check.to;
    if (check.error === "reason_required")
      throw bqBadRequest("reason-required", "A reason of at least three characters is required");
    if (check.error === "not_stale")
      throw bqConflict(
        "variation-not-stale",
        "This variation is already based on the newest approved version",
      );
    throw bqConflict(
      "invalid-transition",
      `A ${row.status} variation cannot be ${action === "reopen" ? "reopened" : `${action}ed`}`,
    );
  }

  create(principal: Principal, projectId: string, input: CreateVariationRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const { project, effective } = await this.access.editable(scope, projectId);
          const found = await versionsOf(tx, access.tenantId, projectId);
          const base = found ? latestApproved(found.versions) : null;
          if (!found || !base)
            throw bqConflict(
              "baseline-not-approved",
              "Approve the original BQ as the contract baseline before raising variations",
            );
          const instruction = await InstructionsService.row(scope, projectId, input.instructionId);
          if (instruction.status !== "open")
            throw bqConflict("instruction-closed", "This instruction is closed");
          const id = uuidv7();
          const number = await this.nextNumber(tx, access.tenantId, projectId);
          const row = await tx.variationOrder.create({
            data: {
              id,
              tenantId: access.tenantId,
              projectId,
              bqId: found.bq.id,
              instructionId: instruction.id,
              baseVersionId: base.id,
              number,
              title: input.title,
              description: input.description ?? null,
              createdBy: access.userId,
              updatedBy: access.userId,
            },
          });
          await this.statusChange(
            tx,
            row,
            { from: null, to: "draft", action: "create" },
            access.userId,
          );
          await this.scope.audit(tx, "variation.created", id, {
            projectId,
            number,
            instructionId: instruction.id,
            baseVersionId: base.id,
          });
          return this.detail(scope, row, project.status as ProjectStatus, effective);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw recordConflict();
        throw error;
      });
  }

  update(
    principal: Principal,
    projectId: string,
    variationId: string,
    input: UpdateVariationRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const { project, effective } = await this.access.editable(scope, projectId);
        const row = await this.row(scope, projectId, variationId);
        if (row.status !== "draft")
          throw bqConflict("invalid-transition", "Only a draft variation can be edited");
        if (row.version !== input.version) throw recordConflict();
        const data: Prisma.VariationOrderUpdateManyMutationInput = {
          version: { increment: 1 },
          updatedBy: access.userId,
          updatedAt: new Date(),
        };
        const fields: string[] = [];
        if (input.title !== undefined) {
          data.title = input.title;
          fields.push("title");
        }
        if (input.description !== undefined) {
          data.description = input.description;
          fields.push("description");
        }
        let instructionId = row.instructionId;
        if (input.instructionId !== undefined && input.instructionId !== row.instructionId) {
          const instruction = await InstructionsService.row(scope, projectId, input.instructionId);
          if (instruction.status !== "open")
            throw bqConflict("instruction-closed", "This instruction is closed");
          instructionId = instruction.id;
          fields.push("instructionId");
        }
        const updated = await tx.variationOrder.updateMany({
          where: { tenantId: access.tenantId, id: variationId, version: input.version },
          data: { ...data, instructionId },
        });
        if (!updated.count) throw recordConflict();
        await this.scope.audit(tx, "variation.updated", variationId, {
          projectId,
          fields: fields.sort(),
        });
        return this.detail(
          scope,
          await this.row(scope, projectId, variationId),
          project.status as ProjectStatus,
          effective,
        );
      },
      true,
    );
  }

  /** Replaces every line of a draft (priced against its base version), keeping line identities. */
  saveLines(
    principal: Principal,
    projectId: string,
    variationId: string,
    input: SaveVariationLinesRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const { project, effective } = await this.access.editable(scope, projectId);
        const row = await this.row(scope, projectId, variationId);
        if (row.status !== "draft")
          throw bqConflict("invalid-transition", "Only a draft variation can be edited");
        if (row.version !== input.version) throw recordConflict();
        const existing = await tx.variationLine.findMany({
          where: { tenantId: access.tenantId, variationId },
        });
        const byId = new Map(existing.map((line) => [line.id, line]));
        const lines: { id: string; input: VariationLineInput }[] = [];
        for (const [index, line] of input.lines.entries()) {
          const previous = line.id ? byId.get(line.id) : undefined;
          if (line.id && (!previous || previous.action !== line.action))
            throw bqBadRequest("variation-line-invalid", `Line ${index + 1}: unknown line`);
          const common = {
            itemLineageId: null,
            billLineageId: null,
            sectionLineageId: null,
            newSection: null,
            newLineageId: null,
            ref: null,
            description: null,
            unit: null,
            unitRaw: null,
            kind: null,
            quantity: null,
            rate: null,
            amountMinor: null,
            note: line.note ?? null,
          } satisfies Omit<VariationLineInput, "action">;
          let value: VariationLineInput;
          if (line.action === "adjust")
            value = {
              ...common,
              action: "adjust",
              itemLineageId: line.itemLineageId,
              quantity: line.quantity ?? null,
              rate: line.rate ?? null,
              amountMinor: line.amountMinor ?? null,
            };
          else if (line.action === "omit")
            value = { ...common, action: "omit", itemLineageId: line.itemLineageId };
          else {
            const unit = line.unit ?? null;
            value = {
              ...common,
              action: "add",
              billLineageId: line.billLineageId,
              sectionLineageId: line.sectionLineageId ?? null,
              newSection:
                line.sectionLineageId || !line.newSection
                  ? null
                  : { code: line.newSection.code ?? null, title: line.newSection.title },
              // The new item's lineage is fixed when the line is first saved.
              newLineageId: previous?.newLineageId ?? uuidv7(),
              ref: line.ref ?? null,
              description: line.description,
              unit,
              unitRaw: unit === null || unit === "other" ? null : BQ_UNIT_LABELS[unit],
              kind: line.kind,
              quantity: line.quantity ?? null,
              rate: line.rate ?? null,
              amountMinor: line.amountMinor ?? null,
            };
          }
          lines.push({ id: previous?.id ?? uuidv7(), input: value });
        }
        const content = await loadContent(tx, access.tenantId, row.baseVersionId);
        const checked = priceVariationLines(
          lines.map((line) => line.input),
          content,
        );
        if (!checked.ok)
          throw bqBadRequest("variation-line-invalid", lineIssue(checked.error, checked.index));
        await this.writeLines(tx, row, lines, checked.priced);
        const totals = variationTotals(checked.priced);
        const updated = await tx.variationOrder.updateMany({
          where: { tenantId: access.tenantId, id: variationId, version: input.version },
          data: {
            additionsMinor: BigInt(totals.additionsMinor),
            omissionsMinor: BigInt(totals.omissionsMinor),
            netMinor: BigInt(totals.netMinor),
            lineCount: lines.length,
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: new Date(),
          },
        });
        if (!updated.count) throw recordConflict();
        const count = (action: VariationLineAction) =>
          lines.filter((line) => line.input.action === action).length;
        await this.scope.audit(tx, "variation.lines_saved", variationId, {
          projectId,
          lines: lines.length,
          adjusted: count("adjust"),
          omitted: count("omit"),
          added: count("add"),
        });
        return this.detail(
          scope,
          await this.row(scope, projectId, variationId),
          project.status as ProjectStatus,
          effective,
        );
      },
      true,
    );
  }

  private async writeLines(
    tx: Tx,
    row: VariationRow,
    lines: { id: string; input: VariationLineInput }[],
    priced: readonly PricedLine[],
  ) {
    await tx.variationLine.deleteMany({ where: { tenantId: row.tenantId, variationId: row.id } });
    if (!lines.length) return;
    await tx.variationLine.createMany({
      data: lines.map(({ id, input }, index) => ({
        id,
        tenantId: row.tenantId,
        variationId: row.id,
        baseVersionId: row.baseVersionId,
        lineNo: index + 1,
        action: input.action,
        itemLineageId: input.itemLineageId,
        billLineageId: input.billLineageId,
        sectionLineageId: input.sectionLineageId,
        newSectionCode: input.newSection?.code ?? null,
        newSectionTitle: input.newSection?.title ?? null,
        newLineageId: input.newLineageId,
        ref: input.ref,
        description: input.description,
        unit: input.unit,
        unitRaw: input.unitRaw,
        kind: input.kind,
        quantity: input.quantity,
        rate: input.rate,
        amountMinor: input.amountMinor === null ? null : BigInt(input.amountMinor),
        note: input.note,
        baseAmountMinor: BigInt(priced[index]!.baseAmountMinor),
        newAmountMinor: BigInt(priced[index]!.newAmountMinor),
        deltaMinor: BigInt(priced[index]!.deltaMinor),
      })),
    });
  }

  /**
   * The proposal as stored: lines priced against the base (refusing invalid or no-op lines), the
   * totals and the snapshot digest the submission freezes and a decision must quote.
   */
  private async proposal(tx: Tx, row: VariationRow, base: BqVersionRow) {
    const [lines, content] = await Promise.all([
      tx.variationLine.findMany({
        where: { tenantId: row.tenantId, variationId: row.id },
        orderBy: { lineNo: "asc" },
      }),
      loadContent(tx, row.tenantId, base.id),
    ]);
    const inputs = lines.map(toInput);
    const checked = priceVariationLines(inputs, content);
    if (!checked.ok)
      throw bqConflict(
        checked.error === "line-no-change" ? "line-no-change" : "variation-line-invalid",
        lineIssue(checked.error, checked.index),
      );
    const totals = variationTotals(checked.priced);
    const digest = variationDigest({
      variationId: row.id,
      instructionId: row.instructionId,
      baseVersionId: base.id,
      baseGrandTotalMinor: safeMinor(base.grandTotalMinor),
      vatRatePercent: base.vatRatePercent.toFixed(),
      lines: inputs.map((input, index) => ({
        ...input,
        baseAmountMinor: checked.priced[index]!.baseAmountMinor,
        newAmountMinor: checked.priced[index]!.newAmountMinor,
      })),
      totals,
    });
    return { lines, inputs, priced: checked.priced, totals, digest, content };
  }

  submit(
    principal: Principal,
    projectId: string,
    variationId: string,
    input: { version: number },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const { project, effective } = await this.access.editable(scope, projectId);
        const row = await this.row(scope, projectId, variationId);
        const to = this.assertTransition(row, "submit");
        if (row.version !== input.version) throw recordConflict();
        if (row.lineCount === 0)
          throw bqConflict("variation-empty", "Add at least one line before submitting");
        const found = (await versionsOf(tx, access.tenantId, projectId))!;
        const latest = latestApproved(found.versions)!;
        if (latest.id !== row.baseVersionId)
          throw bqConflict(
            "variation-stale",
            "A newer BQ version was approved; rebase this variation before submitting",
          );
        const proposal = await this.proposal(tx, row, latest);
        const now = new Date();
        const updated = await tx.variationOrder.updateMany({
          where: {
            tenantId: access.tenantId,
            id: variationId,
            version: input.version,
            status: "draft",
          },
          data: {
            status: to,
            snapshotDigest: proposal.digest,
            submittedBy: access.userId,
            submittedAt: now,
            additionsMinor: BigInt(proposal.totals.additionsMinor),
            omissionsMinor: BigInt(proposal.totals.omissionsMinor),
            netMinor: BigInt(proposal.totals.netMinor),
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: now,
          },
        });
        if (!updated.count) throw recordConflict();
        await this.statusChange(
          tx,
          row,
          { from: row.status, to, action: "submit", digest: proposal.digest },
          access.userId,
        );
        await this.scope.audit(tx, "variation.submitted", variationId, {
          projectId,
          number: row.number,
          lines: proposal.lines.length,
          baseVersionId: row.baseVersionId,
          digest: proposal.digest,
        });
        return this.detail(
          scope,
          await this.row(scope, projectId, variationId),
          project.status as ProjectStatus,
          effective,
        );
      },
      true,
    );
  }

  /** Checks shared by approve and reject: state, independence, snapshot and record version. */
  private assertDecidable(
    scope: Scope,
    row: VariationRow,
    action: "approve" | "reject",
    input: { version: number; snapshotDigest: string; reason?: string },
  ) {
    const to = this.assertTransition(row, action, { reason: input.reason });
    if (isVariationMaker(row, scope.access.userId))
      throw bqProblem(
        403,
        "maker-checker",
        "Someone who did not raise, edit or submit this variation must decide it",
      );
    if (input.snapshotDigest !== row.snapshotDigest)
      throw bqConflict(
        "variation-stale",
        "This variation changed since you opened it. Reload and review it again.",
      );
    if (row.version !== input.version) throw recordConflict();
    return to;
  }

  /**
   * Approves a submitted variation and, in the same transaction, creates the next BQ version:
   * the base version's content copied with every line applied, totals and VAT recomputed at the
   * base's VAT rate, linked to its parent and to this variation. Refused when the snapshot no
   * longer matches or the base is no longer the newest approved version (variation-stale).
   */
  approve(
    principal: Principal,
    projectId: string,
    variationId: string,
    input: { version: number; snapshotDigest: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const { project, effective } = await this.access.approver(scope, projectId);
        const first = await this.row(scope, projectId, variationId);
        // One approval per BQ at a time (the company row is already locked by TenantScope).
        await tx.$queryRaw`SELECT id FROM bqs WHERE tenant_id = ${access.tenantId}::uuid
          AND id = ${first.bqId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM variation_orders WHERE tenant_id = ${access.tenantId}::uuid
          AND id = ${variationId}::uuid FOR UPDATE`;
        const row = await this.row(scope, projectId, variationId);
        const to = this.assertDecidable(scope, row, "approve", input);
        const found = (await versionsOf(tx, access.tenantId, projectId))!;
        const latest = latestApproved(found.versions)!;
        if (latest.id !== row.baseVersionId)
          throw bqConflict(
            "variation-stale",
            "Another variation was approved since this one was submitted; rebase it and submit again",
          );
        const proposal = await this.proposal(tx, row, latest);
        if (proposal.digest !== row.snapshotDigest)
          throw bqConflict(
            "variation-stale",
            "The submitted proposal no longer matches its snapshot",
          );

        const applied = applyVariation(
          proposal.content,
          proposal.inputs,
          proposal.priced,
          latest.vatRatePercent.toFixed(),
          uuidv7,
        );
        const versionId = uuidv7();
        await tx.bqVersion.create({
          data: {
            id: versionId,
            tenantId: access.tenantId,
            projectId,
            bqId: row.bqId,
            versionNo: latest.versionNo + 1,
            status: "draft",
            source: "variation",
            parentVersionId: latest.id,
            variationId: row.id,
            vatRatePercent: latest.vatRatePercent,
            vatRuleKey: latest.vatRuleKey,
            vatRuleStatus: latest.vatRuleStatus,
            rounding: latest.rounding,
            subtotalMinor: BigInt(applied.totals.subtotalMinor),
            vatMinor: BigInt(applied.totals.vatMinor),
            grandTotalMinor: BigInt(applied.totals.grandTotalMinor),
            billCount: applied.totals.billCount,
            itemCount: applied.totals.itemCount,
            // The proposal's maker and the person who froze it; the approver is neither.
            createdBy: row.createdBy,
            updatedBy: row.submittedBy!,
          },
        });
        const written = await this.writer.copyContent(
          tx,
          { tenantId: access.tenantId, versionId },
          applied.content,
          applied.totals,
        );
        const now = new Date();
        const decided = await tx.variationOrder.updateMany({
          where: {
            tenantId: access.tenantId,
            id: variationId,
            version: input.version,
            status: "submitted",
          },
          data: {
            status: to,
            decidedBy: access.userId,
            decidedAt: now,
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: now,
          },
        });
        if (!decided.count) throw recordConflict();
        await tx.bqVersion.update({
          where: { tenantId_id: { tenantId: access.tenantId, id: versionId } },
          data: { status: "approved", approvedBy: access.userId, approvedAt: now },
        });
        await this.statusChange(
          tx,
          row,
          { from: row.status, to, action: "approve", digest: row.snapshotDigest },
          access.userId,
        );
        await this.scope.audit(tx, "variation.approved", variationId, {
          projectId,
          number: row.number,
          baseVersionId: latest.id,
          versionId,
          versionNo: latest.versionNo + 1,
          digest: row.snapshotDigest,
          ...applied.counts,
          ...written,
        });
        return this.detail(
          scope,
          await this.row(scope, projectId, variationId),
          project.status as ProjectStatus,
          effective,
        );
      },
      true,
      APPROVE_TIMEOUT_MS,
    );
  }

  reject(
    principal: Principal,
    projectId: string,
    variationId: string,
    input: { version: number; snapshotDigest: string; reason: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const { project, effective } = await this.access.load(
          scope,
          projectId,
          "bq.approve_variation",
        );
        if (isProjectReadOnly(project.status as ProjectStatus))
          throw bqConflict("project-read-only", "Closed and cancelled projects are read-only");
        const row = await this.row(scope, projectId, variationId);
        const to = this.assertDecidable(scope, row, "reject", input);
        const now = new Date();
        const updated = await tx.variationOrder.updateMany({
          where: {
            tenantId: access.tenantId,
            id: variationId,
            version: input.version,
            status: "submitted",
          },
          data: {
            status: to,
            decidedBy: access.userId,
            decidedAt: now,
            decisionReason: input.reason,
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: now,
          },
        });
        if (!updated.count) throw recordConflict();
        await this.statusChange(
          tx,
          row,
          {
            from: row.status,
            to,
            action: "reject",
            reason: input.reason,
            digest: row.snapshotDigest,
          },
          access.userId,
        );
        // The reason is free text, so the audit log records only that one was given.
        await this.scope.audit(tx, "variation.rejected", variationId, {
          projectId,
          number: row.number,
          reasonGiven: true,
        });
        return this.detail(
          scope,
          await this.row(scope, projectId, variationId),
          project.status as ProjectStatus,
          effective,
        );
      },
      true,
    );
  }

  /** Rejected → draft: the snapshot and decision are cleared; the proposal can be edited again. */
  reopen(
    principal: Principal,
    projectId: string,
    variationId: string,
    input: { version: number },
    req: Request,
  ) {
    return this.simple(principal, projectId, variationId, "reopen", input, req);
  }

  /** Draft → cancelled, with a reason (kept in the variation's history, not the audit log). */
  cancel(
    principal: Principal,
    projectId: string,
    variationId: string,
    input: { version: number; reason: string },
    req: Request,
  ) {
    return this.simple(principal, projectId, variationId, "cancel", input, req);
  }

  private simple(
    principal: Principal,
    projectId: string,
    variationId: string,
    action: "reopen" | "cancel",
    input: { version: number; reason?: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const { project, effective } = await this.access.editable(scope, projectId);
        const row = await this.row(scope, projectId, variationId);
        const to = this.assertTransition(row, action, { reason: input.reason });
        if (row.version !== input.version) throw recordConflict();
        const now = new Date();
        const data: Prisma.VariationOrderUpdateManyMutationInput =
          action === "cancel"
            ? { status: to, cancelReason: input.reason! }
            : {
                status: to,
                snapshotDigest: null,
                submittedBy: null,
                submittedAt: null,
                decidedBy: null,
                decidedAt: null,
                decisionReason: null,
              };
        const updated = await tx.variationOrder.updateMany({
          where: { tenantId: access.tenantId, id: variationId, version: input.version },
          data: { ...data, version: { increment: 1 }, updatedBy: access.userId, updatedAt: now },
        });
        if (!updated.count) throw recordConflict();
        await this.statusChange(
          tx,
          row,
          { from: row.status, to, action, reason: input.reason ?? null },
          access.userId,
        );
        await this.scope.audit(
          tx,
          `variation.${action === "cancel" ? "cancelled" : "reopened"}`,
          variationId,
          {
            projectId,
            number: row.number,
            ...(action === "cancel" ? { reasonGiven: true } : {}),
          },
        );
        return this.detail(
          scope,
          await this.row(scope, projectId, variationId),
          project.status as ProjectStatus,
          effective,
        );
      },
      true,
    );
  }

  /**
   * Re-points a stale variation (draft, submitted or rejected) to the newest approved version and
   * returns it to draft: the lines follow the new base (database cascade), each line is priced
   * again where it still applies, the totals are recomputed, and any snapshot or decision is
   * cleared, so it must be reviewed and submitted again.
   */
  rebase(
    principal: Principal,
    projectId: string,
    variationId: string,
    input: { version: number },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const { project, effective } = await this.access.editable(scope, projectId);
        const row = await this.row(scope, projectId, variationId);
        const found = (await versionsOf(tx, access.tenantId, projectId))!;
        const latest = latestApproved(found.versions)!;
        const to = this.assertTransition(row, "rebase", { stale: latest.id !== row.baseVersionId });
        if (row.version !== input.version) throw recordConflict();
        const now = new Date();
        const moved = await tx.variationOrder.updateMany({
          where: { tenantId: access.tenantId, id: variationId, version: input.version },
          data: {
            status: to,
            baseVersionId: latest.id,
            snapshotDigest: null,
            submittedBy: null,
            submittedAt: null,
            decidedBy: null,
            decidedAt: null,
            decisionReason: null,
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: now,
          },
        });
        if (!moved.count) throw recordConflict();
        const content = await loadContent(tx, access.tenantId, latest.id);
        const lines = await tx.variationLine.findMany({
          where: { tenantId: access.tenantId, variationId },
          orderBy: { lineNo: "asc" },
        });
        let repriced = 0;
        let invalid = 0;
        const deltas: { deltaMinor: number }[] = [];
        for (const line of lines) {
          const result = priceVariationLine(toInput(line), content);
          if (!result.ok) {
            invalid += 1;
            deltas.push({ deltaMinor: safeMinor(line.deltaMinor) });
            continue;
          }
          deltas.push(result.priced);
          if (
            safeMinor(line.baseAmountMinor) !== result.priced.baseAmountMinor ||
            safeMinor(line.newAmountMinor) !== result.priced.newAmountMinor
          ) {
            repriced += 1;
            await tx.variationLine.update({
              where: { id: line.id },
              data: {
                baseAmountMinor: BigInt(result.priced.baseAmountMinor),
                newAmountMinor: BigInt(result.priced.newAmountMinor),
                deltaMinor: BigInt(result.priced.deltaMinor),
              },
            });
          }
        }
        const totals = variationTotals(deltas);
        await tx.variationOrder.update({
          where: { tenantId_id: { tenantId: access.tenantId, id: variationId } },
          data: {
            additionsMinor: BigInt(totals.additionsMinor),
            omissionsMinor: BigInt(totals.omissionsMinor),
            netMinor: BigInt(totals.netMinor),
          },
        });
        await this.statusChange(tx, row, { from: row.status, to, action: "rebase" }, access.userId);
        await this.scope.audit(tx, "variation.rebased", variationId, {
          projectId,
          number: row.number,
          fromVersionId: row.baseVersionId,
          toVersionId: latest.id,
          lines: lines.length,
          repriced,
          invalid,
        });
        return this.detail(
          scope,
          await this.row(scope, projectId, variationId),
          project.status as ProjectStatus,
          effective,
        );
      },
      true,
    );
  }
}
