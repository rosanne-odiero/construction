/**
 * Instructions and Variation Orders in the Playwright mock API. The state machine, pricing,
 * application, totals and snapshot text are the real packages/domain functions; requests and
 * responses go through the shared schemas (checked again by mock-api.mts before sending).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  allowedVariationActions,
  applyVariation,
  BQ_UNIT_LABELS,
  checkVariationTransition,
  priceVariationLine,
  priceVariationLines,
  projectedTotals,
  variationSnapshotText,
  variationTotals,
  type VariationLineInput,
} from "@pm-buddy/domain";
import type { VariationAction, VariationStatus } from "@pm-buddy/types";
import {
  approveVariationRequestSchema,
  cancelVariationRequestSchema,
  createInstructionRequestSchema,
  createVariationRequestSchema,
  instructionResponseSchema,
  instructionsResponseSchema,
  rejectVariationRequestSchema,
  saveVariationLinesRequestSchema,
  updateInstructionRequestSchema,
  updateVariationRequestSchema,
  variationResponseSchema,
  variationsResponseSchema,
  variationVersionRequestSchema,
  type Instruction,
  type Project,
  type VariationDetail,
  type VariationLineInputWire,
  type VariationSummary,
} from "@pm-buddy/validation";
import {
  idsFor,
  latestApproved,
  totalsOf,
  VAT,
  type BqDeps,
  type BqState,
  type MockVariation,
  type ProjectBq,
  type Reply,
} from "./mock-bq-model.mts";
import { netOf, variationEffect } from "./mock-bq-versions.mts";

const readOnly = (project: Project) =>
  project.status === "closed" || project.status === "cancelled";
const now = () => new Date().toISOString();

function toInput(line: VariationLineInputWire, previous?: VariationLineInput): VariationLineInput {
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
  };
  if (line.action === "adjust")
    return {
      ...common,
      action: "adjust",
      itemLineageId: line.itemLineageId,
      quantity: line.quantity ?? null,
      rate: line.rate ?? null,
      amountMinor: line.amountMinor ?? null,
    };
  if (line.action === "omit")
    return { ...common, action: "omit", itemLineageId: line.itemLineageId };
  const unit = line.unit ?? null;
  return {
    ...common,
    action: "add",
    billLineageId: line.billLineageId,
    sectionLineageId: line.sectionLineageId ?? null,
    newSection:
      line.sectionLineageId || !line.newSection
        ? null
        : { code: line.newSection.code ?? null, title: line.newSection.title },
    newLineageId: previous?.newLineageId ?? randomUUID(),
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

function summary(entry: ProjectBq, variation: MockVariation): VariationSummary {
  const base = entry.versions.find((version) => version.id === variation.baseVersionId)!;
  const result = entry.versions.find((version) => version.variation?.id === variation.id);
  const instruction = entry.instructions.find((item) => item.id === variation.instructionId)!;
  const totals = variationTotals(variation.priced);
  return {
    id: variation.id,
    number: variation.number,
    title: variation.title,
    status: variation.status,
    instruction: { id: instruction.id, number: instruction.number, subject: instruction.subject },
    baseVersion: { id: base.id, versionNo: base.versionNo },
    resultVersion: result ? { id: result.id, versionNo: result.versionNo } : null,
    totals,
    grandTotalEffectMinor: variationEffect(entry, base.id, totals.netMinor).grandTotalEffectMinor,
    lineCount: variation.lines.length,
    stale:
      ["draft", "submitted", "rejected"].includes(variation.status) &&
      latestApproved(entry)?.id !== variation.baseVersionId,
    createdBy: variation.createdBy,
    createdAt: variation.createdAt,
    submittedAt: variation.submittedAt,
    decidedAt: variation.decidedAt,
    version: variation.version,
  };
}

function detail(deps: BqDeps, project: Project, entry: ProjectBq, variation: MockVariation) {
  const head = summary(entry, variation);
  const base = entry.versions.find((version) => version.id === variation.baseVersionId)!;
  const latest = latestApproved(entry)!;
  const permissions = deps.permissions();
  const maker = [variation.createdBy.id, variation.submittedBy?.id].includes(deps.actor.id);
  const locked = readOnly(project);
  const actions = allowedVariationActions(variation.status).filter((action) => {
    if (locked) return false;
    if (action === "approve" || action === "reject")
      return (
        permissions.includes("bq.approve_variation") &&
        !maker &&
        (action === "reject" || !head.stale)
      );
    if (action === "rebase") return permissions.includes("bq.edit") && head.stale;
    return permissions.includes("bq.edit");
  });
  const totals = totalsOf(base);
  const projected = projectedTotals(totals, head.totals.netMinor, VAT);
  const bills = new Map(base.content.bills.map((bill) => [bill.lineageId, bill]));
  const sections = new Map(base.content.sections.map((section) => [section.lineageId, section]));
  const items = new Map(base.content.items.map((item) => [item.lineageId, item]));
  const body: VariationDetail = {
    ...head,
    description: variation.description,
    lines: variation.lines.map(({ id, input }, index) => {
      const item = input.itemLineageId ? items.get(input.itemLineageId) : undefined;
      const bill = bills.get(item?.billLineageId ?? input.billLineageId ?? "");
      const section = sections.get(item?.sectionLineageId ?? input.sectionLineageId ?? "");
      const priced = variation.priced[index]!;
      let issue = null;
      if (variation.status === "draft") {
        const check = priceVariationLine(input, base.content);
        issue = !check.ok ? check.error : check.priced.noChange ? "line-no-change" : null;
      }
      return {
        id,
        lineNo: index + 1,
        action: input.action,
        itemLineageId: input.itemLineageId,
        billLineageId: input.billLineageId,
        sectionLineageId: input.sectionLineageId,
        newSection: input.newSection,
        newLineageId: input.newLineageId,
        ref: input.ref,
        description: input.description,
        unit: input.unit,
        kind: input.kind,
        quantity: input.quantity,
        rate: input.rate,
        amountMinor: input.amountMinor,
        note: input.note,
        ...priced,
        issue,
        target: {
          billNumber: bill?.number ?? "",
          billTitle: bill?.title ?? "",
          sectionTitle: section?.title ?? input.newSection?.title ?? null,
          ref: item ? item.ref : input.ref,
          description: item ? item.description : input.description,
          unit: item ? item.unit : input.unit,
          unitRaw: item ? item.unitRaw : input.unitRaw,
          quantity: item?.quantity ?? null,
          rate: item?.rate ?? null,
          amountSource: item?.amountSource ?? null,
        },
      };
    }),
    baseTotals: {
      subtotalMinor: totals.subtotalMinor,
      vatMinor: totals.vatMinor,
      grandTotalMinor: totals.grandTotalMinor,
    },
    projected: {
      subtotalMinor: projected.subtotalMinor,
      vatMinor: projected.vatMinor,
      grandTotalMinor: projected.grandTotalMinor,
    },
    vatRatePercent: VAT,
    latestVersion: { id: latest.id, versionNo: latest.versionNo },
    snapshot:
      variation.digest && variation.submittedAt && variation.submittedBy
        ? {
            digest: variation.digest,
            submittedAt: variation.submittedAt,
            submittedBy: variation.submittedBy,
          }
        : null,
    decision:
      (variation.status === "approved" || variation.status === "rejected") &&
      variation.decidedBy &&
      variation.decidedAt
        ? {
            outcome: variation.status,
            by: variation.decidedBy,
            at: variation.decidedAt,
            reason: variation.decisionReason,
          }
        : null,
    cancelReason: variation.cancelReason,
    history: variation.history,
    permissions: {
      canEdit: variation.status === "draft" && permissions.includes("bq.edit") && !locked,
      actions,
      approvalBlocker:
        variation.status !== "submitted"
          ? "status"
          : locked
            ? "read-only"
            : !permissions.includes("bq.approve_variation")
              ? "permission"
              : maker
                ? "maker"
                : head.stale
                  ? "stale"
                  : null,
    },
  };
  return { body: { variation: body }, schema: variationResponseSchema };
}

function digestOf(entry: ProjectBq, variation: MockVariation) {
  const base = entry.versions.find((version) => version.id === variation.baseVersionId)!;
  return createHash("sha256")
    .update(
      variationSnapshotText({
        variationId: variation.id,
        instructionId: variation.instructionId,
        baseVersionId: base.id,
        baseGrandTotalMinor: totalsOf(base).grandTotalMinor,
        vatRatePercent: VAT,
        lines: variation.lines.map(({ input }, index) => ({
          ...input,
          baseAmountMinor: variation.priced[index]!.baseAmountMinor,
          newAmountMinor: variation.priced[index]!.newAmountMinor,
        })),
        totals: variationTotals(variation.priced),
      }),
    )
    .digest("hex");
}

function instructionWire(entry: ProjectBq, instruction: Instruction): Instruction {
  const related = entry.variations.filter(
    (variation) => variation.instructionId === instruction.id,
  );
  return {
    ...instruction,
    variations: {
      total: related.length,
      approved: related.filter((variation) => variation.status === "approved").length,
      pending: related.filter((variation) => variation.status === "submitted").length,
    },
  };
}

export function handleVariations(
  deps: BqDeps,
  _state: BqState,
  method: string,
  rest: string,
  query: URLSearchParams,
  body: unknown,
  projectBq: () => { project: Project; entry: ProjectBq },
): Reply | null {
  const editor = () => {
    const found = projectBq();
    if (!deps.permissions().includes("bq.edit")) throw deps.fail(403, "forbidden");
    if (readOnly(found.project)) throw deps.fail(409, "project-read-only");
    return found;
  };

  if (rest === "bq/instructions" && method === "GET") {
    const { project, entry } = projectBq();
    return {
      body: {
        instructions: [...entry.instructions]
          .sort((left, right) => right.issuedOn.localeCompare(left.issuedOn))
          .map((instruction) => instructionWire(entry, instruction)),
        permissions: { canEdit: deps.permissions().includes("bq.edit") && !readOnly(project) },
      },
      schema: instructionsResponseSchema,
    };
  }
  if (rest === "bq/instructions" && method === "POST") {
    const { entry } = editor();
    const input = deps.parse(createInstructionRequestSchema, body);
    if (entry.instructions.some((instruction) => instruction.number === input.number))
      throw deps.fail(409, "instruction-number-taken");
    const instruction: Instruction = {
      id: randomUUID(),
      number: input.number,
      issuedOn: input.issuedOn,
      issuerName: input.issuerName,
      issuerRole: input.issuerRole,
      subject: input.subject,
      description: input.description ?? null,
      attachments: input.attachments,
      status: "open",
      variations: { total: 0, approved: 0, pending: 0 },
      createdBy: deps.actor,
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    };
    entry.instructions.push(instruction);
    return { status: 201, body: { instruction }, schema: instructionResponseSchema };
  }
  const instructionMatch = /^bq\/instructions\/([^/]+)$/.exec(rest);
  if (instructionMatch) {
    const { entry } = method === "GET" ? projectBq() : editor();
    const instruction = entry.instructions.find((item) => item.id === instructionMatch[1]);
    if (!instruction) throw deps.fail(404, "not-found");
    if (method === "PATCH") {
      const { version, ...fields } = deps.parse(updateInstructionRequestSchema, body);
      if (instruction.version !== version) throw deps.fail(409, "version-conflict");
      if (
        fields.number &&
        entry.instructions.some(
          (item) => item.id !== instruction.id && item.number === fields.number,
        )
      )
        throw deps.fail(409, "instruction-number-taken");
      Object.assign(
        instruction,
        Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
        { version: version + 1, updatedAt: now() },
      );
    }
    return {
      body: { instruction: instructionWire(entry, instruction) },
      schema: instructionResponseSchema,
    };
  }

  if (rest === "bq/variations" && method === "GET") {
    const { project, entry } = projectBq();
    const status = query.get("status");
    const canCreate = deps.permissions().includes("bq.edit") && !readOnly(project);
    return {
      body: {
        variations: [...entry.variations]
          .filter((variation) => !status || variation.status === status)
          .reverse()
          .map((variation) => summary(entry, variation)),
        permissions: {
          canCreate,
          canApprove: deps.permissions().includes("bq.approve_variation") && !readOnly(project),
        },
        createBlocker: readOnly(project)
          ? "read-only"
          : !deps.permissions().includes("bq.edit")
            ? "permission"
            : !latestApproved(entry)
              ? "no-baseline"
              : null,
      },
      schema: variationsResponseSchema,
    };
  }
  if (rest === "bq/variations" && method === "POST") {
    const { project, entry } = editor();
    const input = deps.parse(createVariationRequestSchema, body);
    const base = latestApproved(entry);
    if (!base) throw deps.fail(409, "baseline-not-approved");
    const instruction = entry.instructions.find((item) => item.id === input.instructionId);
    if (!instruction) throw deps.fail(404, "not-found");
    if (instruction.status !== "open") throw deps.fail(409, "instruction-closed");
    const variation: MockVariation = {
      id: randomUUID(),
      number: `VO-${String(entry.variations.length + 1).padStart(3, "0")}`,
      title: input.title,
      description: input.description ?? null,
      status: "draft",
      instructionId: instruction.id,
      baseVersionId: base.id,
      lines: [],
      priced: [],
      createdBy: deps.actor,
      createdAt: now(),
      submittedBy: null,
      submittedAt: null,
      digest: null,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      cancelReason: null,
      history: [
        { from: null, to: "draft", action: "create", reason: null, by: deps.actor, at: now() },
      ],
      version: 1,
    };
    entry.variations.push(variation);
    return { ...detail(deps, project, entry, variation), status: 201 };
  }
  const variationMatch =
    /^bq\/variations\/([^/]+)(?:\/(lines|submit|approve|reject|reopen|cancel|rebase))?$/.exec(rest);
  if (!variationMatch) return null;
  const { project, entry } = projectBq();
  const variation = entry.variations.find((item) => item.id === variationMatch[1]);
  if (!variation) throw deps.fail(404, "not-found");
  const action = variationMatch[2];
  if (!action && method === "GET") return detail(deps, project, entry, variation);

  const latest = latestApproved(entry)!;
  const stale = latest.id !== variation.baseVersionId;
  const record = (to: VariationStatus, kind: VariationAction, reason: string | null = null) => {
    variation.history.push({
      from: variation.status,
      to,
      action: kind,
      reason,
      by: deps.actor,
      at: now(),
    });
    variation.status = to;
    variation.version += 1;
  };
  const transition = (kind: VariationAction, reason?: string) => {
    const check = checkVariationTransition({
      status: variation.status,
      action: kind,
      reason,
      stale,
    });
    if (!check.ok)
      throw deps.fail(
        check.error === "reason_required" ? 400 : 409,
        check.error === "reason_required"
          ? "reason-required"
          : check.error === "not_stale"
            ? "variation-not-stale"
            : "invalid-transition",
      );
    return check.to;
  };

  if (!action && method === "PATCH") {
    editor();
    const input = deps.parse(updateVariationRequestSchema, body);
    if (variation.status !== "draft") throw deps.fail(409, "invalid-transition");
    if (variation.version !== input.version) throw deps.fail(409, "version-conflict");
    if (input.title !== undefined) variation.title = input.title;
    if (input.description !== undefined) variation.description = input.description;
    if (input.instructionId !== undefined) variation.instructionId = input.instructionId;
    variation.version += 1;
    return detail(deps, project, entry, variation);
  }
  if (action === "lines" && method === "PUT") {
    editor();
    const input = deps.parse(saveVariationLinesRequestSchema, body);
    if (variation.status !== "draft") throw deps.fail(409, "invalid-transition");
    if (variation.version !== input.version) throw deps.fail(409, "version-conflict");
    const lines = input.lines.map((line) => {
      const previous = line.id
        ? variation.lines.find((entryLine) => entryLine.id === line.id)
        : undefined;
      if (line.id && !previous) throw deps.fail(400, "variation-line-invalid");
      return { id: previous?.id ?? randomUUID(), input: toInput(line, previous?.input) };
    });
    const base = entry.versions.find((version) => version.id === variation.baseVersionId)!;
    const checked = priceVariationLines(
      lines.map((line) => line.input),
      base.content,
    );
    if (!checked.ok) throw deps.fail(400, "variation-line-invalid");
    variation.lines = lines;
    variation.priced = checked.priced.map(({ baseAmountMinor, newAmountMinor, deltaMinor }) => ({
      baseAmountMinor,
      newAmountMinor,
      deltaMinor,
    }));
    variation.version += 1;
    return detail(deps, project, entry, variation);
  }
  if (method !== "POST" || !action) throw deps.fail(404, "not-found");

  if (action === "approve" || action === "reject") {
    const input: { version: number; snapshotDigest: string; reason: string | null } =
      action === "approve"
        ? { ...deps.parse(approveVariationRequestSchema, body), reason: null }
        : deps.parse(rejectVariationRequestSchema, body);
    if (!deps.permissions().includes("bq.approve_variation")) throw deps.fail(403, "forbidden");
    if (action === "approve") deps.requireStepUp();
    if (readOnly(project)) throw deps.fail(409, "project-read-only");
    const to = transition(action, input.reason ?? undefined);
    if ([variation.createdBy.id, variation.submittedBy?.id].includes(deps.actor.id))
      throw deps.fail(403, "maker-checker");
    if (input.snapshotDigest !== variation.digest) throw deps.fail(409, "variation-stale");
    if (variation.version !== input.version) throw deps.fail(409, "version-conflict");
    if (action === "approve") {
      if (stale) throw deps.fail(409, "variation-stale");
      const base = latest;
      const checked = priceVariationLines(
        variation.lines.map((line) => line.input),
        base.content,
      );
      if (!checked.ok) throw deps.fail(409, "variation-line-invalid");
      const applied = applyVariation(
        base.content,
        variation.lines.map((line) => line.input),
        checked.priced,
        VAT,
        randomUUID,
      );
      const at = now();
      entry.versions.push({
        id: randomUUID(),
        versionNo: base.versionNo + 1,
        version: 1,
        status: "approved",
        source: "variation",
        parentVersionId: base.id,
        variation: { id: variation.id, number: variation.number },
        createdBy: variation.createdBy,
        updatedBy: variation.submittedBy ?? variation.createdBy,
        approvedBy: deps.actor,
        approvedAt: at,
        createdAt: at,
        updatedAt: at,
        content: applied.content,
        ids: idsFor(applied.content),
        importId: null,
      });
    } else variation.decisionReason = input.reason;
    variation.decidedBy = deps.actor;
    variation.decidedAt = now();
    record(to, action, input.reason);
    return detail(deps, project, entry, variation);
  }

  editor();
  if (action === "cancel") {
    const input = deps.parse(cancelVariationRequestSchema, body);
    const to = transition("cancel", input.reason);
    if (variation.version !== input.version) throw deps.fail(409, "version-conflict");
    variation.cancelReason = input.reason;
    record(to, "cancel", input.reason);
    return detail(deps, project, entry, variation);
  }
  const input = deps.parse(variationVersionRequestSchema, body);
  const to = transition(action as VariationAction);
  if (variation.version !== input.version) throw deps.fail(409, "version-conflict");
  if (action === "submit") {
    if (!variation.lines.length) throw deps.fail(409, "variation-empty");
    if (stale) throw deps.fail(409, "variation-stale");
    const checked = priceVariationLines(
      variation.lines.map((line) => line.input),
      latest.content,
    );
    if (!checked.ok)
      throw deps.fail(
        409,
        checked.error === "line-no-change" ? "line-no-change" : "variation-line-invalid",
      );
    variation.submittedBy = deps.actor;
    variation.submittedAt = now();
    variation.digest = digestOf(entry, variation);
  } else {
    if (action === "rebase") {
      variation.baseVersionId = latest.id;
      variation.priced = variation.lines.map(({ input: line }, index) => {
        const result = priceVariationLine(line, latest.content);
        return result.ok
          ? {
              baseAmountMinor: result.priced.baseAmountMinor,
              newAmountMinor: result.priced.newAmountMinor,
              deltaMinor: result.priced.deltaMinor,
            }
          : variation.priced[index]!;
      });
    }
    Object.assign(variation, {
      submittedBy: null,
      submittedAt: null,
      digest: null,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
    });
  }
  record(to, action as VariationAction);
  return detail(deps, project, entry, variation);
}

export { netOf };
