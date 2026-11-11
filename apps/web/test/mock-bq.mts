/**
 * BQ endpoints of the Playwright mock API (see mock-api.mts). Workbook parsing is simulated with
 * the grids in mock-bq-grids.mts; detection, the hierarchy, validation and totals use the real
 * packages/domain code, and every request and response goes through the shared schemas.
 */
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
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
  type BqMapping,
  type BqResolutions,
  type WorkbookGrid,
} from "@pm-buddy/domain";
import { BQ_ISSUES, type BqImportStatus, type Permission } from "@pm-buddy/types";
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
  type BqBillWire,
  type BqImport,
  type BqItemWire,
  type BqResponse,
  type BqTemplate,
  type Project,
} from "@pm-buddy/validation";
import { messyGrid, multiBillGrid } from "./mock-bq-grids.mts";

const NOW = "2026-11-10T07:45:00.000Z";
const OWNER = { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" };
const QS = { id: "21000000-0000-4000-8000-000000000004", displayName: "Faith Achieng" };
const VAT = "16";

type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
type Fail = (status: number, code: string) => Error;
type MockImport = { record: BqImport; grid: WorkbookGrid };
type Version = {
  id: string;
  versionNo: number;
  version: number;
  status: "draft";
  createdAt: string;
  updatedAt: string;
  bills: { bill: BqBillWire; items: BqItemWire[] }[];
  result: BqBuildResult;
  importId: string;
};
export type ProjectBq = { imports: MockImport[]; version: Version | null };
export type BqState = { projects: Map<string, ProjectBq>; templates: BqTemplate[] };

export type BqDeps = {
  fail: Fail;
  parse<T>(schema: z.ZodType<T>, body: unknown): T;
  project(permission: Permission): Project;
  permissions(): Permission[];
};

const mappingOf = (record: BqImport) => record.mapping as unknown as BqMapping;

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
      uploadedBy: OWNER,
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

function toVersion(entry: MockImport, result: BqBuildResult, previous: Version | null): Version {
  let itemIndex = 0;
  const bills = result.bills.map((bill) => {
    const billId = randomUUID();
    const sections = bill.sections.map((section) => ({ id: randomUUID(), section }));
    const items: BqItemWire[] = sections.flatMap(({ id: sectionId, section }) =>
      section.items.map((item) => ({
        id: `00000000-0000-4000-8000-${String(++itemIndex).padStart(12, "0")}`,
        sectionId,
        ref: item.ref,
        description: item.description,
        unit: item.unit,
        unitRaw: item.unitRaw,
        quantity: item.quantity,
        rate: item.rate,
        amountMinor: item.amountMinor,
        sheetAmountMinor: item.sheetAmountMinor,
        amountSource: item.amountSource,
        overrideReason: item.overrideReason,
        kind: item.kind,
        notes: item.notes,
        sourceSheet: bill.sheetName,
        sourceRow: item.sheetRow,
        hasFormula: item.hasFormula,
      })),
    );
    return {
      bill: {
        id: billId,
        number: bill.number,
        title: bill.title,
        kind: bill.kind,
        totalMinor: bill.totalMinor,
        sheetTotalMinor: bill.sheetTotalMinor,
        itemCount: bill.itemCount,
        sections: sections.map(({ id: sectionId, section }) => ({
          id: sectionId,
          code: section.code,
          title: section.title,
          notes: section.notes,
          totalMinor: section.totalMinor,
          itemCount: section.items.length,
        })),
      },
      items,
    };
  });
  const now = new Date().toISOString();
  return {
    id: previous?.id ?? randomUUID(),
    versionNo: 1,
    version: (previous?.version ?? 0) + 1,
    status: "draft",
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    bills,
    result,
    importId: entry.record.id,
  };
}

/** Ruiru starts with a committed BQ from the multi-bill workbook; other projects have none. */
export function initialProjectBq(withBq: boolean, contractSumMinor: number | null): ProjectBq {
  if (!withBq) return { imports: [], version: null };
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
  const version = toVersion(entry, result, null);
  entry.record.bqVersionId = version.id;
  return { imports: [entry], version };
}

const canImport = (deps: BqDeps) => deps.permissions().includes("bq.import");

function bqView(deps: BqDeps, project: Project, state: ProjectBq): BqResponse {
  const permissions = { canImport: canImport(deps), canExport: true };
  const openImports = permissions.canImport
    ? state.imports.filter((entry) => isImportResumable(entry.record.status)).length
    : 0;
  const version = state.version;
  if (!version) return { bq: null, permissions, openImports };
  const source = state.imports.find((entry) => entry.record.id === version.importId)!.record;
  const result = version.result;
  return {
    bq: {
      id: "40000000-0000-4000-8000-000000000001",
      name: "Bill of Quantities",
      version: {
        id: version.id,
        versionNo: version.versionNo,
        status: version.status,
        source: "import",
        vatRatePercent: VAT,
        vatRuleKey: "bq.vat.rate",
        vatRuleStatus: "compliance_review",
        rounding: "half_up_line",
        subtotalMinor: result.totals.subtotalMinor,
        vatMinor: result.totals.vatMinor,
        grandTotalMinor: result.totals.grandTotalMinor,
        billCount: result.totals.billCount,
        itemCount: result.totals.itemCount,
        createdAt: version.createdAt,
        updatedAt: version.updatedAt,
        version: version.version,
      },
      bills: version.bills.map((entry) => entry.bill),
      byKind: result.totals.byKind,
      contractSumMinor: project.contractSumMinor,
      source: {
        importId: source.id,
        fileName: source.fileName,
        fileType: source.fileType,
        committedAt: source.committedAt!,
        committedBy: source.committedBy!,
        counts: source.report?.counts ?? {},
        accepted: source.resolutions.accepted,
        overrides: source.resolutions.rows.map((entry) => {
          const findings = (source.report?.issues ?? []).filter(
            (issue) => issue.sheetIndex === entry.sheetIndex && issue.row === entry.row,
          );
          return {
            sheet: source.sheets?.[entry.sheetIndex]?.name ?? "Sheet",
            row: entry.row,
            ref: findings.find((issue) => issue.ref)?.ref ?? null,
            action: entry.action,
            reason: entry.reason ?? null,
            codes: [...new Set(findings.map((issue) => issue.code))],
          };
        }),
      },
    },
    permissions,
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
      entry = { imports: [], version: null };
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
  const bill = /^bq\/bills\/([^/]+)$/.exec(rest);
  if (bill && method === "GET") {
    const { entry } = projectBq();
    const found = entry.version?.bills.find((candidate) => candidate.bill.id === bill[1]);
    if (!found) throw deps.fail(404, "not-found");
    return { body: found, schema: bqBillResponseSchema };
  }
  if (rest === "bq/search" && method === "GET") {
    const { entry } = projectBq();
    const text = (query.get("q") ?? "").trim().toLowerCase();
    if (text.length < 2) throw deps.fail(400, "validation-error");
    const items = (entry.version?.bills ?? []).flatMap(({ bill: wire, items: list }) =>
      list
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
      const current = entry.version;
      const differences = current
        ? (() => {
            const before = new Map(current.bills.map(({ bill: wire }) => [wire.number, wire]));
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
                grandTotalMinor: current.result.totals.grandTotalMinor,
                itemCount: current.result.totals.itemCount,
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
      const previous = entry.version;
      if (previous) {
        const old = entry.imports.find((candidate) => candidate.record.id === previous.importId);
        if (old) old.record.status = "superseded";
      }
      entry.version = toVersion(found, result, previous);
      touch(record, input.version);
      Object.assign(record, {
        status: "committed",
        committedAt: new Date().toISOString(),
        committedBy: OWNER,
        bqVersionId: entry.version.id,
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
      createdBy: OWNER,
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
