/**
 * BQ endpoints of the Playwright mock API (see mock-api.mts). Workbook parsing is simulated with
 * the grids in mock-bq-grids.mts; detection, the hierarchy, validation and totals use the real
 * packages/domain code, and every request and response goes through the shared schemas.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  analyseSheet,
  buildBqImport,
  canTransitionImport,
  cellText,
  columnLetter,
  hasFormula,
  invalidResolutions,
  isImportResumable,
  proposeMapping,
  templateColumns,
  templateFromMapping,
  headerSignature,
  type BqBuildResult,
  type BqResolutions,
  type WorkbookGrid,
} from "@pm-buddy/domain";
import { BQ_ISSUES, type BqImportStatus } from "@pm-buddy/types";
import {
  applyBqTemplateRequestSchema,
  bqBillResponseSchema,
  bqImportResponseSchema,
  bqImportSummarySchema,
  bqImportsResponseSchema,
  bqImportVersionRequestSchema,
  bqPreviewResponseSchema,
  bqResponseSchema,
  bqSearchResponseSchema,
  bqSheetRowsResponseSchema,
  bqTemplateResponseSchema,
  bqTemplatesResponseSchema,
  createBqTemplateRequestSchema,
  messageResponseSchema,
  saveBqMappingRequestSchema,
  saveBqResolutionsRequestSchema,
  type BqImport,
  type BqResponse,
  type BqTemplate,
  type Project,
} from "@pm-buddy/validation";
import { messyGrid, multiBillGrid } from "./mock-bq-grids.mts";
import {
  billItems,
  billWires,
  byKindOf,
  contentFromBuild,
  currentVersion,
  emptyProjectBq,
  idsFor,
  mappingOf,
  totalsOf,
  VAT,
  versionWire,
  type BqDeps,
  type BqState,
  type MockImport,
  type MockVersion,
  type ProjectBq,
  type Reply,
} from "./mock-bq-model.mts";
import { handleVersions } from "./mock-bq-versions.mts";
import { handleVariations } from "./mock-variations.mts";

const NOW = "2026-11-10T07:45:00.000Z";
const OWNER = { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" };
const QS = { id: "21000000-0000-4000-8000-000000000004", displayName: "Faith Achieng" };

export type { BqDeps, BqState, ProjectBq } from "./mock-bq-model.mts";

function report(result: BqBuildResult) {
  const total = Object.values(result.counts).reduce((sum, count) => sum + (count ?? 0), 0);
  return {
    issues: result.issues,
    counts: result.counts as Record<string, number>,
    unresolvedCounts: result.unresolvedCounts as Record<string, number>,
    truncated: result.issues.length < total,
    totals: result.totals,
    readiness: result.readiness,
    vatRuleStatus: "compliance_review",
    generatedAt: new Date().toISOString(),
  };
}

function build(
  entry: MockImport,
  contractSumMinor: number | null,
  resolutions: BqResolutions,
  cap = true,
) {
  return buildBqImport(
    entry.grid,
    mappingOf(entry.record),
    { vatRatePercent: VAT, contractSumMinor, maxIssuesPerCode: cap ? 300 : undefined },
    resolutions,
  );
}

function newImport(
  grid: WorkbookGrid,
  fileName: string,
  size: number,
  templates: BqTemplate[],
  uploader: { id: string; displayName: string } = OWNER,
): MockImport {
  const analyses = grid.sheets.map((sheet, index) => analyseSheet(sheet, index));
  const { mapping, templateMatches } = proposeMapping(
    grid,
    analyses,
    templates.map((template) => ({
      id: template.id,
      signature: template.signature,
      columns: template.columns,
      dataOffset: template.dataOffset,
    })),
  );
  return {
    grid,
    record: {
      id: randomUUID(),
      status: "parsed",
      fileName,
      fileType: "xlsx",
      fileSizeBytes: size,
      fileSha256: createHash("sha256").update(fileName).digest("hex"),
      scanStatus: "not_scanned",
      scanEngine: "development-noop",
      failureCode: null,
      uploadedBy: uploader,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      committedAt: null,
      bqVersionId: null,
      version: 1,
      sheets: analyses.map((analysis) => ({
        index: analysis.index,
        name: analysis.name,
        hidden: analysis.hidden,
        usedRows: analysis.usedRows,
        usedColumns: analysis.usedColumns,
        kind: analysis.kind,
        kindConfidence: analysis.kindConfidence,
        headerRow: analysis.header?.row ?? null,
        headerConfidence: analysis.header?.confidence ?? null,
        headerSignature: analysis.header?.signature ?? null,
        proposedColumns: { ...analysis.header?.columns },
        billNumber: analysis.bill.number,
        billTitle: analysis.bill.title,
        firstDataRow: analysis.firstDataRow,
        lastDataRow: analysis.lastDataRow,
        itemRows: analysis.itemRows,
        templateId: templateMatches[analysis.index] ?? null,
      })),
      mapping,
      resolutions: { rows: [], accepted: [] },
      report: null,
      committedBy: null,
    },
  };
}

/** Version 1 (draft) from a committed import, or the draft it replaces (same row, new content). */
function importVersion(
  entry: MockImport,
  result: BqBuildResult,
  previous: MockVersion | null,
  actor: { id: string; displayName: string },
): MockVersion {
  const now = new Date().toISOString();
  const content = contentFromBuild(result);
  return {
    id: previous?.id ?? randomUUID(),
    versionNo: 1,
    version: (previous?.version ?? 0) + 1,
    status: "draft",
    source: "import",
    parentVersionId: null,
    variation: null,
    createdBy: previous?.createdBy ?? actor,
    updatedBy: actor,
    approvedBy: null,
    approvedAt: null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    content,
    ids: idsFor(content),
    importId: entry.record.id,
  };
}

/** Ruiru starts with a committed BQ from the multi-bill workbook; other projects have none. */
export function initialProjectBq(withBq: boolean, contractSumMinor: number | null): ProjectBq {
  if (!withBq) return emptyProjectBq();
  const entry = newImport(multiBillGrid(), "kenyan-multi-bill.xlsx", 19_414, []);
  const first = build(entry, contractSumMinor, { rows: [], accepted: [] }, false);
  const resolutions: BqResolutions = {
    rows: [],
    accepted: first.readiness.unacceptedWarnings.map((code) => ({
      code,
      reason: "The contract sum also covers later phases",
    })),
  };
  entry.record.resolutions = resolutions;
  const result = build(entry, contractSumMinor, resolutions, false);
  entry.record = {
    ...entry.record,
    status: "committed",
    uploadedBy: QS,
    createdAt: NOW,
    updatedAt: NOW,
    committedAt: NOW,
    committedBy: QS,
    report: report(result),
    version: 4,
  };
  const version = importVersion(entry, result, null, QS);
  version.createdAt = NOW;
  version.updatedAt = NOW;
  entry.record.bqVersionId = version.id;
  return { ...emptyProjectBq(), imports: [entry], versions: [version] };
}

const canImport = (deps: BqDeps) => deps.permissions().includes("bq.import");

const readOnly = (project: Project) =>
  project.status === "closed" || project.status === "cancelled";

/** People who prepared the draft baseline: none of them may approve it. */
const makersOf = (entry: ProjectBq, version: MockVersion) => {
  const source = entry.imports.find((candidate) => candidate.record.id === version.importId);
  return new Set([
    version.createdBy.id,
    version.updatedBy.id,
    source?.record.uploadedBy.id,
    source?.record.committedBy?.id,
  ]);
};

function baselineApproval(deps: BqDeps, project: Project, entry: ProjectBq) {
  const version = currentVersion(entry);
  if (!version) return { allowed: false, refusal: "no-bq" as const };
  if (version.status !== "draft") return { allowed: false, refusal: "not-draft" as const };
  if (readOnly(project)) return { allowed: false, refusal: "read-only" as const };
  if (!deps.permissions().includes("bq.approve_variation"))
    return { allowed: false, refusal: "permission" as const };
  if (makersOf(entry, version).has(deps.actor.id))
    return { allowed: false, refusal: "maker" as const };
  return { allowed: true, refusal: null };
}

function bqView(deps: BqDeps, project: Project, entry: ProjectBq): BqResponse {
  const permissions = {
    canImport: canImport(deps) && !readOnly(project),
    canExport: true,
    canEdit: deps.permissions().includes("bq.edit") && !readOnly(project),
    canApprove: deps.permissions().includes("bq.approve_variation") && !readOnly(project),
  };
  const openImports = permissions.canImport
    ? entry.imports.filter((candidate) => isImportResumable(candidate.record.status)).length
    : 0;
  const version = currentVersion(entry);
  const approval = baselineApproval(deps, project, entry);
  if (!version) return { bq: null, permissions, baselineApproval: approval, openImports };
  const source = entry.imports.find(
    (candidate) => candidate.record.id === version.importId,
  )?.record;
  return {
    bq: {
      id: "40000000-0000-4000-8000-000000000001",
      name: "Bill of Quantities",
      version: versionWire(entry, version),
      bills: billWires(version),
      byKind: byKindOf(version),
      contractSumMinor: project.contractSumMinor,
      source: source
        ? {
            importId: source.id,
            fileName: source.fileName,
            fileType: source.fileType,
            committedAt: source.committedAt!,
            committedBy: source.committedBy!,
            counts: source.report?.counts ?? {},
            accepted: source.resolutions.accepted,
            overrides: source.resolutions.rows.map((row) => {
              const findings = (source.report?.issues ?? []).filter(
                (issue) => issue.sheetIndex === row.sheetIndex && issue.row === row.row,
              );
              return {
                sheet: source.sheets?.[row.sheetIndex]?.name ?? "Sheet",
                row: row.row,
                ref: findings.find((issue) => issue.ref)?.ref ?? null,
                action: row.action,
                reason: row.reason ?? null,
                codes: [...new Set(findings.map((issue) => issue.code))],
              };
            }),
          }
        : null,
    },
    permissions,
    baselineApproval: approval,
    openImports,
  };
}

/** Pulls the file name and the first bytes of the `file` part out of a multipart body. */
function uploaded(raw: Buffer): { name: string; head: Buffer; size: number } | null {
  const text = raw.toString("latin1");
  const name = /filename="([^"]*)"/.exec(text)?.[1];
  const start = text.indexOf("\r\n\r\n");
  if (!name || start < 0) return null;
  const end = text.lastIndexOf("\r\n--");
  const body = raw.subarray(start + 4, end > start ? end : raw.length);
  return { name, head: body.subarray(0, 8), size: body.length };
}

export async function handleBq(
  deps: BqDeps,
  state: BqState,
  method: string,
  rest: string,
  query: URLSearchParams,
  body: unknown,
  raw: Buffer,
): Promise<Reply> {
  const projectBq = () => {
    const project = deps.project("bq.view");
    let entry = state.projects.get(project.id);
    if (!entry) {
      entry = emptyProjectBq();
      state.projects.set(project.id, entry);
    }
    return { project, entry };
  };
  const importer = () => {
    if (!canImport(deps)) throw deps.fail(403, "forbidden");
    return projectBq();
  };
  const findImport = (entry: ProjectBq, importId: string) => {
    const found = entry.imports.find((candidate) => candidate.record.id === importId);
    if (!found) throw deps.fail(404, "not-found");
    return found;
  };
  const transition = (record: BqImport, to: BqImportStatus) => {
    if (!canTransitionImport(record.status, to)) throw deps.fail(409, "invalid-import-state");
  };
  const touch = (record: BqImport, expected: number) => {
    if (record.version !== expected) throw deps.fail(409, "version-conflict");
    record.version += 1;
    record.updatedAt = new Date().toISOString();
  };
  const reply = (record: BqImport, status = 200): Reply => ({
    status,
    body: { import: record },
    schema: bqImportResponseSchema,
  });

  if (rest === "bq" && method === "GET") {
    const { project, entry } = projectBq();
    return { body: bqView(deps, project, entry), schema: bqResponseSchema };
  }
  const bill = /^bq\/(?:versions\/([^/]+)\/)?bills\/([^/]+)$/.exec(rest);
  if (bill && method === "GET") {
    const { entry } = projectBq();
    const version = bill[1]
      ? entry.versions.find((candidate) => candidate.id === bill[1])
      : currentVersion(entry);
    const found = version ? billWires(version).find((candidate) => candidate.id === bill[2]) : null;
    if (!version || !found) throw deps.fail(404, "not-found");
    return {
      body: { bill: found, items: billItems(state, entry, version, found.lineageId) },
      schema: bqBillResponseSchema,
    };
  }
  if (rest === "bq/search" && method === "GET") {
    const { entry } = projectBq();
    const text = (query.get("q") ?? "").trim().toLowerCase();
    if (text.length < 2) throw deps.fail(400, "validation-error");
    const version = currentVersion(entry);
    const wires = version ? billWires(version) : [];
    const items = wires.flatMap((wire) =>
      billItems(state, entry, version!, wire.lineageId)
        .filter(
          (item) =>
            item.description.toLowerCase().includes(text) || item.ref?.toLowerCase().includes(text),
        )
        .map((item) => ({
          ...item,
          billId: wire.id,
          billNumber: wire.number,
          sectionTitle:
            wire.sections.find((section) => section.id === item.sectionId)?.title ?? null,
        })),
    );
    return {
      body: { items: items.slice(0, 200), truncated: items.length > 200 },
      schema: bqSearchResponseSchema,
    };
  }
  if (rest === "bq/imports" && method === "GET") {
    const { entry } = importer();
    return {
      body: {
        imports: [...entry.imports]
          .reverse()
          .map(({ record }) =>
            Object.fromEntries(
              Object.keys(bqImportSummarySchema.shape).map((key) => [
                key,
                record[key as keyof typeof record],
              ]),
            ),
          ),
      },
      schema: bqImportsResponseSchema,
    };
  }
  if (rest === "bq/imports" && method === "POST") {
    const { entry } = importer();
    const file = uploaded(raw);
    if (!file || !file.size) throw deps.fail(400, "file-required");
    const zip = file.head[0] === 0x50 && file.head[1] === 0x4b;
    if (!/\.xlsx$/i.test(file.name) || !zip) throw deps.fail(415, "unsupported-file-type");
    const created = newImport(
      /messy/i.test(file.name) ? messyGrid() : multiBillGrid(),
      file.name,
      file.size,
      state.templates,
      deps.actor,
    );
    entry.imports.push(created);
    return reply(created.record, 201);
  }
  const importMatch = /^bq\/imports\/([^/]+)(?:\/(.*))?$/.exec(rest);
  if (importMatch) {
    const { project, entry } = importer();
    const found = findImport(entry, importMatch[1]!);
    const record = found.record;
    const action = importMatch[2] ?? "";
    if (action === "" && method === "GET") return reply(record);
    const rows = /^sheets\/(\d+)\/rows$/.exec(action);
    if (rows && method === "GET") {
      const sheet = found.grid.sheets[Number(rows[1])];
      if (!sheet) throw deps.fail(404, "sheet-not-found");
      const from = Math.max(1, Number(query.get("from") ?? 1));
      const count = Math.min(200, Math.max(1, Number(query.get("count") ?? 60)));
      const summary = record.sheets![Number(rows[1])]!;
      const width = Math.max(summary.usedColumns, 1);
      const window = [];
      for (let row = from; row <= Math.min(sheet.rows.length, from + count - 1); row += 1) {
        const cells = sheet.rows[row - 1] ?? [];
        window.push({
          row,
          cells: Array.from(
            { length: width },
            (_, column) => cellText(cells[column] ?? null, 160) || null,
          ),
          formulas: Array.from({ length: width }, (_, column) => column).filter((column) =>
            hasFormula(cells[column] ?? null),
          ),
        });
      }
      return {
        body: {
          sheetIndex: Number(rows[1]),
          name: sheet.name,
          from,
          totalRows: summary.usedRows,
          columns: Array.from({ length: width }, (_, index) => ({
            index,
            letter: columnLetter(index),
          })),
          rows: window,
        },
        schema: bqSheetRowsResponseSchema,
      };
    }
    if (action === "mapping" && method === "PUT") {
      const input = deps.parse(saveBqMappingRequestSchema, body);
      transition(record, "mapped");
      touch(record, input.version);
      Object.assign(record, {
        status: "mapped",
        mapping: input.mapping,
        report: null,
        resolutions: { rows: [], accepted: [] },
      });
      return reply(record);
    }
    if (action === "apply-template" && method === "POST") {
      const input = deps.parse(applyBqTemplateRequestSchema, body);
      transition(record, "mapped");
      const template = state.templates.find((candidate) => candidate.id === input.templateId);
      if (!template) throw deps.fail(404, "not-found");
      let matched = 0;
      const sheets = mappingOf(record).sheets.map((sheet) => {
        const applied = templateColumns(found.grid.sheets[sheet.sheetIndex]!, template);
        if (!applied) return sheet;
        matched += 1;
        return {
          ...sheet,
          include: true,
          role: "bill" as const,
          ...applied,
          lastDataRow: Math.max(applied.firstDataRow, sheet.lastDataRow),
        };
      });
      if (!matched) throw deps.fail(409, "template-not-applicable");
      touch(record, input.version);
      Object.assign(record, {
        status: "mapped",
        mapping: { sheets, templateId: template.id },
        report: null,
        resolutions: { rows: [], accepted: [] },
      });
      return reply(record);
    }
    if (action === "validate" && method === "POST") {
      const input = deps.parse(bqImportVersionRequestSchema, body);
      transition(record, "validated");
      if (record.version !== input.version) throw deps.fail(409, "version-conflict");
      const result = build(found, project.contractSumMinor, record.resolutions);
      touch(record, input.version);
      Object.assign(record, { status: "validated", report: report(result) });
      return reply(record);
    }
    if (action === "resolutions" && method === "PUT") {
      const input = deps.parse(saveBqResolutionsRequestSchema, body);
      if (record.status !== "validated") throw deps.fail(409, "invalid-import-state");
      if (record.version !== input.version) throw deps.fail(409, "version-conflict");
      const resolutions: BqResolutions = {
        rows: input.resolutions.rows.map((row) => ({ ...row, reason: row.reason ?? null })),
        accepted: input.resolutions.accepted,
      };
      const full = build(found, project.contractSumMinor, resolutions, false);
      if (invalidResolutions(full, resolutions.rows).length)
        throw deps.fail(400, "invalid-resolution");
      if (
        resolutions.accepted.some(
          (entry) => BQ_ISSUES[entry.code] !== "warning" || !full.counts[entry.code],
        )
      )
        throw deps.fail(400, "invalid-resolution");
      touch(record, input.version);
      Object.assign(record, {
        resolutions,
        report: report(build(found, project.contractSumMinor, resolutions)),
      });
      return reply(record);
    }
    if (action === "preview" && method === "GET") {
      if (record.status !== "validated") throw deps.fail(409, "invalid-import-state");
      const result = build(found, project.contractSumMinor, record.resolutions);
      const current = currentVersion(entry);
      const differences = current
        ? (() => {
            const before = new Map(billWires(current).map((wire) => [wire.number, wire]));
            type Difference = {
              billNumber: string;
              title: string;
              change: "added" | "removed" | "changed" | "unchanged";
              currentTotalMinor: number | null;
              newTotalMinor: number | null;
              currentItemCount: number | null;
              newItemCount: number | null;
            };
            const list: Difference[] = result.bills.map((next) => {
              const old = before.get(next.number);
              before.delete(next.number);
              return {
                billNumber: next.number,
                title: next.title,
                change: !old
                  ? "added"
                  : old.totalMinor === next.totalMinor && old.itemCount === next.itemCount
                    ? "unchanged"
                    : "changed",
                currentTotalMinor: old?.totalMinor ?? null,
                newTotalMinor: next.totalMinor,
                currentItemCount: old?.itemCount ?? null,
                newItemCount: next.itemCount,
              };
            });
            for (const old of before.values())
              list.push({
                billNumber: old.number,
                title: old.title,
                change: "removed",
                currentTotalMinor: old.totalMinor,
                newTotalMinor: null,
                currentItemCount: old.itemCount,
                newItemCount: null,
              });
            return list;
          })()
        : [];
      return {
        body: {
          importId: record.id,
          totals: result.totals,
          readiness: result.readiness,
          bills: result.bills.map((next) => ({
            number: next.number,
            title: next.title,
            kind: next.kind,
            sheetName: next.sheetName,
            sectionCount: next.sections.length,
            itemCount: next.itemCount,
            totalMinor: next.totalMinor,
            sheetTotalMinor: next.sheetTotalMinor,
          })),
          existingDraft: current
            ? {
                versionId: current.id,
                versionNo: current.versionNo,
                grandTotalMinor: totalsOf(current).grandTotalMinor,
                itemCount: current.content.items.length,
                sourceFileName:
                  entry.imports.find((candidate) => candidate.record.id === current.importId)
                    ?.record.fileName ?? null,
              }
            : null,
          differences,
        },
        schema: bqPreviewResponseSchema,
      };
    }
    if (action === "commit" && method === "POST") {
      const input = deps.parse(bqImportVersionRequestSchema, body);
      transition(record, "committed");
      if (record.version !== input.version) throw deps.fail(409, "version-conflict");
      const result = build(found, project.contractSumMinor, record.resolutions, false);
      if (!result.readiness.canCommit) throw deps.fail(409, "commit-blocked");
      const previous = currentVersion(entry);
      if (previous && previous.status !== "draft") throw deps.fail(409, "bq-not-draft");
      if (previous) {
        const old = entry.imports.find((candidate) => candidate.record.id === previous.importId);
        if (old) old.record.status = "superseded";
      }
      const next = importVersion(found, result, previous, deps.actor);
      entry.versions = [next];
      touch(record, input.version);
      Object.assign(record, {
        status: "committed",
        committedAt: new Date().toISOString(),
        committedBy: deps.actor,
        bqVersionId: next.id,
      });
      return reply(record);
    }
    if (action === "abandon" && method === "POST") {
      const input = deps.parse(bqImportVersionRequestSchema, body);
      if (!isImportResumable(record.status)) throw deps.fail(409, "invalid-import-state");
      touch(record, input.version);
      record.status = "abandoned";
      return reply(record);
    }
    throw deps.fail(404, "not-found");
  }
  const d23 = handleVersions(deps, state, method, rest, query, body, projectBq);
  if (d23) return d23;
  const variations = handleVariations(deps, state, method, rest, query, body, projectBq);
  if (variations) return variations;
  if (rest === "bq/templates" && method === "GET") {
    importer();
    return { body: { templates: state.templates }, schema: bqTemplatesResponseSchema };
  }
  if (rest === "bq/templates" && method === "POST") {
    const { entry } = importer();
    const input = deps.parse(createBqTemplateRequestSchema, body);
    const found = findImport(entry, input.importId);
    const sheetMapping = mappingOf(found.record).sheets.find(
      (sheet) => sheet.sheetIndex === input.sheetIndex,
    );
    if (!sheetMapping || found.record.status === "parsed") throw deps.fail(400, "mapping-invalid");
    if (state.templates.some((template) => template.name === input.name))
      throw deps.fail(409, "template-name-taken");
    const sheet = found.grid.sheets[input.sheetIndex]!;
    const template: BqTemplate = {
      id: randomUUID(),
      name: input.name,
      signature: headerSignature(sheet, sheetMapping.headerRow),
      ...templateFromMapping(sheet, sheetMapping),
      createdAt: new Date().toISOString(),
      createdBy: deps.actor,
    };
    state.templates.push(template);
    return { status: 201, body: { template }, schema: bqTemplateResponseSchema };
  }
  const templateMatch = /^bq\/templates\/([^/]+)$/.exec(rest);
  if (templateMatch && method === "DELETE") {
    importer();
    const before = state.templates.length;
    state.templates = state.templates.filter((template) => template.id !== templateMatch[1]);
    if (state.templates.length === before) throw deps.fail(404, "not-found");
    return { body: { message: "Template deleted" }, schema: messageResponseSchema };
  }
  throw deps.fail(404, "not-found");
}
