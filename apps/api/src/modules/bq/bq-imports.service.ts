import { createHash } from "node:crypto";
import { HttpException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
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
  sanitiseCellText,
  sanitiseFileName,
  templateColumns,
  type BqBuildResult,
  type BqMapping,
  type BqResolutions,
  type BqTemplateLike,
  type WorkbookGrid,
} from "@pm-buddy/domain";
import {
  BQ_IMPORT_LIMITS,
  BQ_ISSUES,
  BQ_ROUNDING,
  BQ_VAT_RULE,
  type BqFileType,
  type BqImportStatus,
} from "@pm-buddy/types";
import {
  bqImportResponseSchema,
  bqImportsResponseSchema,
  bqPreviewResponseSchema,
  bqSheetRowsResponseSchema,
  type BqMappingInput,
  type BqResolutionsInput,
  type BqSheetSummary,
} from "@pm-buddy/validation";
import { AppConfig } from "../../config/app-config.js";
import { describeError } from "../../common/errors.js";
import { uuidv7 } from "../../common/uuid.js";
import { Prisma } from "../../generated/prisma/client.js";
import { MalwareDetected, MalwareScanner } from "../../infra/malware-scanner.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { BqAccess, bqBadRequest, bqConflict, bqProblem, bqVersionConflict } from "./bq-access.js";
import {
  buildDigest,
  REPORT_ISSUES_PER_CODE,
  safeMinor,
  toImport,
  toImportSummary,
  toReport,
  toSheetSummary,
  type BqImportRow,
} from "./bq-mappers.js";
import { BqObjectStore, importKeys } from "./bq-object-store.js";
import { BqVersionWriter } from "./bq-version-writer.js";
import { inspectZip, sniffWorkbook, UploadRefused } from "./parsing/file-inspection.js";
import { parseWorkbook, ParserBusy } from "./parsing/workbook-parser.js";

type Tx = Prisma.TransactionClient;
export type UploadedWorkbook = { originalname: string; size: number; buffer: Buffer };

const REFUSAL_STATUS: Record<UploadRefused["code"], number> = {
  "empty-file": 400,
  "unsupported-file-type": 415,
  "macro-workbook": 415,
  "unsafe-archive": 422,
};

/** Commits can write tens of thousands of rows; they get a longer transaction limit. */
const COMMIT_TIMEOUT_MS = 120_000;
export const BQ_DEFAULT_NAME = "Bill of Quantities";

/** Display names for audit-free responses (uploaders, committers). */
async function displayNames(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const users = await tx.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, displayName: true },
  });
  return new Map(users.map((user) => [user.id, user.displayName]));
}

function assertTransition(from: string, to: BqImportStatus) {
  if (!canTransitionImport(from as BqImportStatus, to))
    throw bqConflict("invalid-import-state", `An import cannot move from ${from} to ${to}`);
}

/**
 * BQ imports (D2.2): upload and safe parsing, mapping, validation, resolutions, preview and the
 * atomic commit, as a resumable state machine (packages/domain BQ_IMPORT_TRANSITIONS). Every
 * operation authorises through AccessPolicy (bq.import on the project) inside the caller's tenant
 * transaction; every change is audited with counts and field names only.
 */
@Injectable()
export class BqImportsService {
  private readonly logger = new Logger(BqImportsService.name);

  constructor(
    private readonly scope: TenantScope,
    private readonly access: BqAccess,
    private readonly objects: BqObjectStore,
    private readonly scanner: MalwareScanner,
    private readonly writer: BqVersionWriter,
    private readonly config: AppConfig,
  ) {}

  private vatRatePercent(): string {
    return this.config.get("BQ_VAT_RATE_PERCENT");
  }

  private async detail(scope: Scope, row: BqImportRow) {
    const people = await displayNames(scope.tx, [row.uploadedBy, row.committedBy]);
    return bqImportResponseSchema.parse({ import: toImport(row, people) });
  }

  list(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "bq.import");
      const rows = await scope.tx.bqImport.findMany({
        where: { tenantId: scope.access.tenantId, projectId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
      });
      const people = await displayNames(
        scope.tx,
        rows.map((row) => row.uploadedBy),
      );
      return bqImportsResponseSchema.parse({
        imports: rows.map((row) => toImportSummary(row, people)),
      });
    });
  }

  get(principal: Principal, projectId: string, importId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "bq.import");
      return this.detail(scope, await this.access.importRow(scope, projectId, importId));
    });
  }

  /**
   * Upload: content signature and zip directory checked, SHA-256 computed, malware hook run, the
   * original stored privately under a generated key, the import recorded, then parsed.
   */
  async upload(
    principal: Principal,
    projectId: string,
    file: UploadedWorkbook | undefined,
    req: Request,
  ) {
    if (!file?.buffer) throw bqBadRequest("file-required", "Attach an Excel workbook as `file`");
    await this.scope.run(principal, req, (scope) => this.access.importable(scope, projectId));
    const fileName = sanitiseFileName(file.originalname, "workbook");
    let fileType: BqFileType;
    try {
      fileType = sniffWorkbook(file.buffer, file.originalname);
      if (fileType === "xlsx") inspectZip(file.buffer);
    } catch (error) {
      if (error instanceof UploadRefused) {
        await this.auditRefusal(principal, projectId, req, error.code);
        throw bqProblem(REFUSAL_STATUS[error.code], error.code, error.message);
      }
      throw error;
    }
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    let scan;
    try {
      scan = await this.scanner.scan(file.buffer, { sha256 });
    } catch (error) {
      if (error instanceof MalwareDetected) {
        await this.auditRefusal(principal, projectId, req, "malware-detected");
        throw bqProblem(422, "malware-detected", "The file was refused by the malware scanner");
      }
      throw error;
    }
    const importId = uuidv7();
    const tenantId = principal.session.activeTenantId!;
    const sourceKey = importKeys(tenantId, projectId, importId).source(fileType);
    await this.objects.putSource(sourceKey, file.buffer, fileType, sha256);
    try {
      await this.scope.run(
        principal,
        req,
        async (scope) => {
          await this.access.importable(scope, projectId);
          await scope.tx.bqImport.create({
            data: {
              id: importId,
              tenantId: scope.access.tenantId,
              projectId,
              fileName,
              fileType,
              fileSizeBytes: file.buffer.length,
              fileSha256: sha256,
              sourceKey,
              scanStatus: scan.status,
              scanEngine: scan.engine,
              scannedAt: scan.scannedAt,
              uploadedBy: scope.access.userId,
            },
          });
          await this.scope.audit(scope.tx, "bq.import.uploaded", importId, {
            projectId,
            fileType,
            sizeBytes: file.buffer.length,
            scan: scan.status,
          });
        },
        true,
      );
    } catch (error) {
      await this.objects.remove(sourceKey).catch(() => undefined);
      throw error;
    }
    return this.parse(principal, projectId, importId, req);
  }

  private async auditRefusal(
    principal: Principal,
    projectId: string,
    req: Request,
    reason: string,
  ) {
    await this.scope
      .run(principal, req, (scope) =>
        this.scope.audit(scope.tx, "bq.import.refused", projectId, { projectId, reason }),
      )
      .catch((error: unknown) =>
        this.logger.warn(`Could not audit a refused BQ upload: ${describeError(error)}`),
      );
  }

  /**
   * Parses an uploaded workbook in the sandboxed worker and records the sheet analysis and the
   * proposed mapping (status parsed), or the failure (status failed). Resumable: an import left
   * `uploaded` (for example after a crash) can be parsed again.
   */
  async parse(principal: Principal, projectId: string, importId: string, req: Request) {
    const row = await this.scope.run(principal, req, async (scope) => {
      await this.access.importable(scope, projectId);
      return this.access.importRow(scope, projectId, importId);
    });
    if (row.status !== "uploaded") assertTransition(row.status, "parsed");
    const content = await this.objects.getSource(row.sourceKey);
    if (createHash("sha256").update(content).digest("hex") !== row.fileSha256)
      throw bqProblem(500, "source-integrity", "The stored workbook does not match its checksum");
    let outcome;
    try {
      outcome = await parseWorkbook(content, row.fileType as BqFileType);
    } catch (error) {
      if (error instanceof ParserBusy)
        throw bqProblem(503, "parser-busy", "Too many workbooks are being read; try again shortly");
      throw error;
    }
    if (!outcome.ok) {
      const failure = outcome.failure;
      return this.scope.run(
        principal,
        req,
        async (scope) => {
          const updated = await scope.tx.bqImport.updateMany({
            where: {
              tenantId: scope.access.tenantId,
              id: importId,
              status: "uploaded",
              version: row.version,
            },
            data: { status: "failed", failureCode: failure, version: { increment: 1 } },
          });
          if (!updated.count) throw bqVersionConflict();
          await this.scope.audit(scope.tx, "bq.import.failed", importId, { projectId, failure });
          return this.detail(scope, await this.access.importRow(scope, projectId, importId));
        },
        true,
      );
    }
    const grid = outcome.grid;
    const analyses = grid.sheets.map((sheet, index) => analyseSheet(sheet, index));
    const parsedKey = importKeys(row.tenantId, projectId, importId).parsed;
    await this.objects.putGrid(parsedKey, grid);
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const templates = await this.templates(scope.tx, scope.access.tenantId);
        const { mapping, templateMatches } = proposeMapping(grid, analyses, templates);
        const sheets = analyses.map((analysis) =>
          toSheetSummary(analysis, templateMatches[analysis.index] ?? null),
        );
        const updated = await scope.tx.bqImport.updateMany({
          where: {
            tenantId: scope.access.tenantId,
            id: importId,
            status: "uploaded",
            version: row.version,
          },
          data: {
            status: "parsed",
            parsedKey,
            sheets: sheets as unknown as Prisma.InputJsonValue,
            mapping: mapping as unknown as Prisma.InputJsonValue,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw bqVersionConflict();
        await this.scope.audit(scope.tx, "bq.import.parsed", importId, {
          projectId,
          sheets: sheets.length,
          billSheets: sheets.filter((sheet) => sheet.kind === "bill").length,
          summarySheets: sheets.filter((sheet) => sheet.kind === "summary").length,
          templateMatched: Object.keys(templateMatches).length > 0,
        });
        return this.detail(scope, await this.access.importRow(scope, projectId, importId));
      },
      true,
    );
  }

  private async templates(tx: Tx, tenantId: string): Promise<BqTemplateLike[]> {
    const rows = await tx.bqMappingTemplate.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
    });
    return rows.map((template) => ({
      id: template.id,
      signature: template.signature,
      columns: template.columns as BqTemplateLike["columns"],
      dataOffset: template.dataOffset,
    }));
  }

  /** Raw rows of a parsed sheet for the mapping screen (bounded window). */
  async rows(
    principal: Principal,
    projectId: string,
    importId: string,
    sheetIndex: number,
    window: { from: number; count: number },
    req: Request,
  ) {
    const row = await this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "bq.import");
      return this.access.importRow(scope, projectId, importId);
    });
    if (!row.parsedKey) throw bqConflict("invalid-import-state", "This import has not been parsed");
    const grid = await this.objects.getGrid(row.parsedKey);
    const sheet = grid.sheets[sheetIndex];
    if (!sheet)
      throw new NotFoundException({ message: "Sheet not found", code: "sheet-not-found" });
    const summary = (row.sheets as BqSheetSummary[] | null)?.[sheetIndex];
    const width = Math.min(
      Math.max(summary?.usedColumns ?? 0, 1),
      BQ_IMPORT_LIMITS.maxColumnsPerSheet,
    );
    const rows = [];
    const last = Math.min(sheet.rows.length, window.from + window.count - 1);
    for (let number = window.from; number <= last; number += 1) {
      const cells = sheet.rows[number - 1] ?? [];
      const display: (string | null)[] = [];
      const formulas: number[] = [];
      for (let column = 0; column < width; column += 1) {
        const cell = cells[column] ?? null;
        const text = cellText(cell, 160);
        display.push(text || null);
        if (hasFormula(cell)) formulas.push(column);
      }
      rows.push({ row: number, cells: display, formulas });
    }
    return bqSheetRowsResponseSchema.parse({
      sheetIndex,
      name: sanitiseCellText(sheet.name, 100).text,
      from: window.from,
      totalRows: summary?.usedRows ?? sheet.rows.length,
      columns: Array.from({ length: width }, (_, index) => ({
        index,
        letter: columnLetter(index),
      })),
      rows,
    });
  }

  /** Confirms the mapping (status mapped). Changing it discards earlier validation and resolutions. */
  saveMapping(
    principal: Principal,
    projectId: string,
    importId: string,
    input: { mapping: BqMappingInput; version: number },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.importable(scope, projectId);
        const row = await this.access.importRow(scope, projectId, importId);
        assertTransition(row.status, "mapped");
        if (row.version !== input.version) throw bqVersionConflict();
        this.checkMappingFits(input.mapping, row.sheets as BqSheetSummary[]);
        const mapping = { ...input.mapping } as BqMapping;
        const updated = await scope.tx.bqImport.updateMany({
          where: { tenantId: scope.access.tenantId, id: importId, version: input.version },
          data: {
            status: "mapped",
            mapping: mapping as unknown as Prisma.InputJsonValue,
            report: Prisma.DbNull,
            reportDigest: null,
            resolutions: { rows: [], accepted: [] },
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw bqVersionConflict();
        const included = mapping.sheets.filter((sheet) => sheet.include);
        await this.scope.audit(scope.tx, "bq.import.mapped", importId, {
          projectId,
          billSheets: included.filter((sheet) => sheet.role === "bill").length,
          summarySheets: included.filter((sheet) => sheet.role === "summary").length,
          fields: [...new Set(included.flatMap((sheet) => Object.keys(sheet.columns)))].sort(),
          template: mapping.templateId !== null,
        });
        return this.detail(scope, await this.access.importRow(scope, projectId, importId));
      },
      true,
    );
  }

  private checkMappingFits(mapping: BqMappingInput, sheets: BqSheetSummary[] | null) {
    for (const sheet of mapping.sheets) {
      const summary = sheets?.[sheet.sheetIndex];
      if (!summary)
        throw bqBadRequest(
          "mapping-invalid",
          `Sheet ${sheet.sheetIndex + 1} is not in this workbook`,
        );
      const limit = summary.usedRows + 1;
      if (sheet.headerRow > limit || sheet.firstDataRow > limit)
        throw bqBadRequest("mapping-invalid", `Rows are outside the sheet "${summary.name}"`);
      const columns = Object.values(sheet.columns).filter((value) => value !== undefined);
      if (columns.some((column) => column >= Math.max(summary.usedColumns, 1)))
        throw bqBadRequest("mapping-invalid", `A column is outside the sheet "${summary.name}"`);
    }
  }

  /** Applies a saved template to every sheet whose header signature matches (status mapped). */
  applyTemplate(
    principal: Principal,
    projectId: string,
    importId: string,
    input: { templateId: string; version: number },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.importable(scope, projectId);
        const row = await this.access.importRow(scope, projectId, importId);
        assertTransition(row.status, "mapped");
        if (row.version !== input.version) throw bqVersionConflict();
        const template = await scope.tx.bqMappingTemplate.findUnique({
          where: { tenantId_id: { tenantId: scope.access.tenantId, id: input.templateId } },
        });
        if (!template) throw new NotFoundException("Template not found");
        const grid = await this.objects.getGrid(row.parsedKey!);
        const like: BqTemplateLike = {
          id: template.id,
          signature: template.signature,
          columns: template.columns as BqTemplateLike["columns"],
          dataOffset: template.dataOffset,
        };
        const current = row.mapping as unknown as BqMapping;
        let matched = 0;
        const sheets = current.sheets.map((sheet) => {
          const applied = templateColumns(grid.sheets[sheet.sheetIndex]!, like);
          if (!applied) return sheet;
          matched += 1;
          return {
            ...sheet,
            include: true,
            role: "bill" as const,
            headerRow: applied.headerRow,
            firstDataRow: applied.firstDataRow,
            lastDataRow: Math.max(applied.firstDataRow, sheet.lastDataRow),
            columns: applied.columns,
          };
        });
        if (!matched)
          throw bqConflict("template-not-applicable", "No sheet has this template's header row");
        const mapping: BqMapping = { sheets, templateId: template.id };
        const updated = await scope.tx.bqImport.updateMany({
          where: { tenantId: scope.access.tenantId, id: importId, version: input.version },
          data: {
            status: "mapped",
            mapping: mapping as unknown as Prisma.InputJsonValue,
            report: Prisma.DbNull,
            reportDigest: null,
            resolutions: { rows: [], accepted: [] },
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw bqVersionConflict();
        await this.scope.audit(scope.tx, "bq.import.template_applied", importId, {
          projectId,
          templateId: template.id,
          sheets: matched,
        });
        return this.detail(scope, await this.access.importRow(scope, projectId, importId));
      },
      true,
    );
  }

  /** Builds the BQ from the stored grid; the build is pure and deterministic. */
  private build(
    grid: WorkbookGrid,
    row: BqImportRow,
    contractSumMinor: number | null,
    resolutions: BqResolutions,
    capped: boolean,
  ): BqBuildResult {
    try {
      return buildBqImport(
        grid,
        row.mapping as unknown as BqMapping,
        {
          vatRatePercent: this.vatRatePercent(),
          contractSumMinor,
          maxIssuesPerCode: capped ? REPORT_ISSUES_PER_CODE : undefined,
        },
        resolutions,
      );
    } catch (error) {
      if (error instanceof RangeError)
        throw bqProblem(422, "amount-out-of-range", "A total in this workbook is out of range");
      throw error;
    }
  }

  /** Reads the import (with permission) and the project's contract sum in one short transaction. */
  private loadForWork(principal: Principal, projectId: string, importId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { project } = await this.access.importable(scope, projectId);
      const row = await this.access.importRow(scope, projectId, importId);
      return {
        row,
        contractSumMinor:
          project.contractSumMinor === null ? null : safeMinor(project.contractSumMinor),
      };
    });
  }

  /** Runs validation and stores the report (status validated). */
  async validate(
    principal: Principal,
    projectId: string,
    importId: string,
    input: { version: number },
    req: Request,
  ) {
    const { row, contractSumMinor } = await this.loadForWork(principal, projectId, importId, req);
    assertTransition(row.status, "validated");
    if (row.version !== input.version) throw bqVersionConflict();
    const grid = await this.objects.getGrid(row.parsedKey!);
    const resolutions = row.resolutions as unknown as BqResolutions;
    const result = this.build(grid, row, contractSumMinor, resolutions, true);
    return this.storeReport(
      principal,
      projectId,
      importId,
      input.version,
      result,
      resolutions,
      req,
      "bq.import.validated",
    );
  }

  private storeReport(
    principal: Principal,
    projectId: string,
    importId: string,
    version: number,
    result: BqBuildResult,
    resolutions: BqResolutions,
    req: Request,
    action: string,
  ) {
    const report = toReport(result, BQ_VAT_RULE.status, new Date());
    const digest = buildDigest(result);
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.importable(scope, projectId);
        const updated = await scope.tx.bqImport.updateMany({
          where: {
            tenantId: scope.access.tenantId,
            id: importId,
            version,
            status: { in: ["mapped", "validated"] },
          },
          data: {
            status: "validated",
            report: report as unknown as Prisma.InputJsonValue,
            reportDigest: digest,
            resolutions: resolutions as unknown as Prisma.InputJsonValue,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw bqVersionConflict();
        const bySeverity = { error: 0, warning: 0, info: 0 };
        for (const [code, count] of Object.entries(result.counts))
          bySeverity[BQ_ISSUES[code as keyof typeof BQ_ISSUES]] += count ?? 0;
        const actions = { computed: 0, sheet: 0, exclude: 0 };
        for (const entry of resolutions.rows) actions[entry.action] += 1;
        await this.scope.audit(scope.tx, action, importId, {
          projectId,
          ...bySeverity,
          canCommit: result.readiness.canCommit,
          resolutions: actions,
          accepted: resolutions.accepted.map((entry) => entry.code).sort(),
        });
        return this.detail(scope, await this.access.importRow(scope, projectId, importId));
      },
      true,
    );
  }

  /**
   * Per-row resolutions (use computed, use sheet amount with a reason, exclude) and accepted
   * warning codes (each with a reason). Revalidates and stores the updated report.
   */
  async resolve(
    principal: Principal,
    projectId: string,
    importId: string,
    input: { resolutions: BqResolutionsInput; version: number },
    req: Request,
  ) {
    const { row, contractSumMinor } = await this.loadForWork(principal, projectId, importId, req);
    if (row.status !== "validated")
      throw bqConflict("invalid-import-state", "Validate the import before resolving findings");
    if (row.version !== input.version) throw bqVersionConflict();
    const resolutions: BqResolutions = {
      rows: input.resolutions.rows.map((entry) => ({
        sheetIndex: entry.sheetIndex,
        row: entry.row,
        action: entry.action,
        reason: entry.reason?.trim() || null,
      })),
      accepted: input.resolutions.accepted.map((entry) => ({
        code: entry.code,
        reason: entry.reason.trim(),
      })),
    };
    const keys = resolutions.rows.map((entry) => `${entry.sheetIndex}:${entry.row}`);
    if (new Set(keys).size !== keys.length)
      throw bqBadRequest("invalid-resolution", "Each row can have one resolution");
    const grid = await this.objects.getGrid(row.parsedKey!);
    const full = this.build(grid, row, contractSumMinor, resolutions, false);
    const rejected = invalidResolutions(full, resolutions.rows);
    if (rejected.length)
      throw bqBadRequest(
        "invalid-resolution",
        `Row ${rejected[0]!.row} has no finding that this resolution applies to, or it needs a reason`,
      );
    for (const entry of resolutions.accepted) {
      if (BQ_ISSUES[entry.code] !== "warning" || !(full.counts[entry.code] ?? 0))
        throw bqBadRequest("invalid-resolution", `There is no warning "${entry.code}" to accept`);
    }
    const result = this.build(grid, row, contractSumMinor, resolutions, true);
    return this.storeReport(
      principal,
      projectId,
      importId,
      input.version,
      result,
      resolutions,
      req,
      "bq.import.resolved",
    );
  }

  /** What a commit would create, and how it differs from the current draft. Changes nothing. */
  async preview(principal: Principal, projectId: string, importId: string, req: Request) {
    const { row, contractSumMinor } = await this.loadForWork(principal, projectId, importId, req);
    if (row.status !== "validated")
      throw bqConflict("invalid-import-state", "Validate the import before previewing it");
    const grid = await this.objects.getGrid(row.parsedKey!);
    const result = this.build(
      grid,
      row,
      contractSumMinor,
      row.resolutions as unknown as BqResolutions,
      true,
    );
    const current = await this.scope.run(principal, req, (scope) =>
      this.currentDraft(scope.tx, scope.access.tenantId, projectId),
    );
    const newBills = result.bills.map((bill) => ({
      number: bill.number,
      title: bill.title,
      kind: bill.kind,
      sheetName: sanitiseCellText(bill.sheetName, 100).text,
      sectionCount: bill.sections.length,
      itemCount: bill.itemCount,
      totalMinor: bill.totalMinor,
      sheetTotalMinor: bill.sheetTotalMinor,
    }));
    const differences: {
      billNumber: string;
      title: string;
      change: "added" | "removed" | "changed" | "unchanged";
      currentTotalMinor: number | null;
      newTotalMinor: number | null;
      currentItemCount: number | null;
      newItemCount: number | null;
    }[] = [];
    if (current) {
      const existing = new Map(current.bills.map((bill) => [bill.number, bill]));
      for (const bill of newBills) {
        const before = existing.get(bill.number);
        existing.delete(bill.number);
        differences.push({
          billNumber: bill.number,
          title: bill.title,
          change: !before
            ? "added"
            : before.totalMinor === bill.totalMinor && before.itemCount === bill.itemCount
              ? "unchanged"
              : "changed",
          currentTotalMinor: before?.totalMinor ?? null,
          newTotalMinor: bill.totalMinor,
          currentItemCount: before?.itemCount ?? null,
          newItemCount: bill.itemCount,
        });
      }
      for (const before of existing.values())
        differences.push({
          billNumber: before.number,
          title: before.title,
          change: "removed",
          currentTotalMinor: before.totalMinor,
          newTotalMinor: null,
          currentItemCount: before.itemCount,
          newItemCount: null,
        });
    }
    return bqPreviewResponseSchema.parse({
      importId,
      totals: result.totals,
      readiness: result.readiness,
      bills: newBills,
      existingDraft: current
        ? {
            versionId: current.version.id,
            versionNo: current.version.versionNo,
            grandTotalMinor: safeMinor(current.version.grandTotalMinor),
            itemCount: current.version.itemCount,
            sourceFileName: current.sourceFileName,
          }
        : null,
      differences,
    });
  }

  private async currentDraft(tx: Tx, tenantId: string, projectId: string) {
    const bq = await tx.bq.findUnique({ where: { tenantId_projectId: { tenantId, projectId } } });
    if (!bq) return null;
    const version = await tx.bqVersion.findFirst({
      where: { tenantId, bqId: bq.id },
      orderBy: { versionNo: "desc" },
    });
    if (!version) return null;
    const [bills, itemCounts, source] = await Promise.all([
      tx.bqBill.findMany({
        where: { tenantId, versionId: version.id },
        orderBy: { sortOrder: "asc" },
      }),
      tx.bqItem.groupBy({
        by: ["billId"],
        where: { tenantId, versionId: version.id },
        _count: { _all: true },
      }),
      tx.bqImport.findFirst({
        where: { tenantId, bqVersionId: version.id, status: "committed" },
        select: { fileName: true },
      }),
    ]);
    const counts = new Map(itemCounts.map((entry) => [entry.billId, entry._count._all]));
    return {
      bq,
      version,
      sourceFileName: source?.fileName ?? null,
      bills: bills.map((bill) => ({
        number: bill.number,
        title: bill.title,
        totalMinor: safeMinor(bill.totalMinor),
        itemCount: counts.get(bill.id) ?? 0,
      })),
    };
  }

  /**
   * The atomic commit: one transaction creates the project's original-contract BQ as version 1
   * (draft) or replaces the current draft's content, writes every bill, section and item, links
   * the import to the version and supersedes the import it replaces. Anything failing rolls back
   * everything; the database re-checks the version's totals before the transaction commits.
   */
  async commit(
    principal: Principal,
    projectId: string,
    importId: string,
    input: { version: number },
    req: Request,
  ) {
    const { row, contractSumMinor } = await this.loadForWork(principal, projectId, importId, req);
    assertTransition(row.status, "committed");
    if (row.version !== input.version) throw bqVersionConflict();
    const grid = await this.objects.getGrid(row.parsedKey!);
    const result = this.build(
      grid,
      row,
      contractSumMinor,
      row.resolutions as unknown as BqResolutions,
      false,
    );
    // The digest covers the bills, totals and readiness, which do not depend on the issue cap.
    if (buildDigest(result) !== row.reportDigest)
      throw bqConflict(
        "validation-stale",
        "The source, configuration or contract sum changed since validation. Validate again.",
      );
    if (!result.readiness.canCommit)
      throw bqConflict(
        "commit-blocked",
        "Resolve every error and accept every warning (with a reason) before committing",
      );
    const vatRatePercent = this.vatRatePercent();
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.importable(scope, projectId);
        // Serialises commits per project (NO KEY so foreign-key checks elsewhere are not blocked).
        await tx.$queryRaw`SELECT id FROM projects WHERE tenant_id = ${access.tenantId}::uuid
          AND id = ${projectId}::uuid FOR NO KEY UPDATE`;
        await tx.$queryRaw`SELECT id FROM bq_imports WHERE tenant_id = ${access.tenantId}::uuid
          AND id = ${importId}::uuid FOR UPDATE`;
        const locked = await this.access.importRow(scope, projectId, importId);
        if (locked.status !== "validated" || locked.version !== input.version)
          throw bqVersionConflict();

        const bq =
          (await tx.bq.findUnique({
            where: { tenantId_projectId: { tenantId: access.tenantId, projectId } },
          })) ??
          (await tx.bq.create({
            data: {
              id: uuidv7(),
              tenantId: access.tenantId,
              projectId,
              name: BQ_DEFAULT_NAME,
              createdBy: access.userId,
            },
          }));
        const existing = await tx.bqVersion.findFirst({
          where: { tenantId: access.tenantId, bqId: bq.id },
          orderBy: { versionNo: "desc" },
        });
        if (existing && existing.status !== "draft")
          throw bqConflict(
            "bq-not-draft",
            "This BQ has been approved; changes need a variation or revision (D2.3)",
          );
        const totals = {
          vatRatePercent,
          vatRuleKey: BQ_VAT_RULE.key,
          vatRuleStatus: BQ_VAT_RULE.status,
          rounding: BQ_ROUNDING,
          subtotalMinor: BigInt(result.totals.subtotalMinor),
          vatMinor: BigInt(result.totals.vatMinor),
          grandTotalMinor: BigInt(result.totals.grandTotalMinor),
          billCount: result.totals.billCount,
          itemCount: result.totals.itemCount,
          updatedBy: access.userId,
        };
        let versionId: string;
        let replaced: string[] = [];
        if (existing) {
          versionId = existing.id;
          const previous = await tx.bqImport.findMany({
            where: { tenantId: access.tenantId, bqVersionId: versionId, status: "committed" },
            select: { id: true, version: true },
          });
          replaced = previous.map((entry) => entry.id);
          for (const entry of previous) {
            await tx.bqImport.updateMany({
              where: { tenantId: access.tenantId, id: entry.id, version: entry.version },
              data: { status: "superseded", version: { increment: 1 } },
            });
          }
          await tx.bqBill.deleteMany({ where: { tenantId: access.tenantId, versionId } });
          await tx.bqVersion.update({
            where: { tenantId_id: { tenantId: access.tenantId, id: versionId } },
            data: { ...totals, version: { increment: 1 } },
          });
        } else {
          versionId = uuidv7();
          await tx.bqVersion.create({
            data: {
              id: versionId,
              tenantId: access.tenantId,
              projectId,
              bqId: bq.id,
              versionNo: 1,
              status: "draft",
              source: "import",
              createdBy: access.userId,
              ...totals,
            },
          });
        }
        const written = await this.writer.writeContent(
          tx,
          { tenantId: access.tenantId, versionId },
          result.bills,
        );
        const updated = await tx.bqImport.updateMany({
          where: {
            tenantId: access.tenantId,
            id: importId,
            version: input.version,
            status: "validated",
          },
          data: {
            status: "committed",
            bqVersionId: versionId,
            committedBy: access.userId,
            committedAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw bqVersionConflict();
        const resolutions = row.resolutions as unknown as BqResolutions;
        await this.scope.audit(tx, "bq.import.committed", importId, {
          projectId,
          versionId,
          versionNo: existing?.versionNo ?? 1,
          replacedDraft: Boolean(existing),
          supersededImports: replaced.length,
          ...written,
          overrides: resolutions.rows.filter((entry) => entry.action === "sheet").length,
          excluded: resolutions.rows.filter((entry) => entry.action === "exclude").length,
          accepted: resolutions.accepted.map((entry) => entry.code).sort(),
        });
        return this.detail(scope, await this.access.importRow(scope, projectId, importId));
      },
      true,
      COMMIT_TIMEOUT_MS,
    );
  }

  /** Abandons an unfinished import (its records and source are kept). */
  abandon(
    principal: Principal,
    projectId: string,
    importId: string,
    input: { version: number },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.load(scope, projectId, "bq.import");
        const row = await this.access.importRow(scope, projectId, importId);
        if (!isImportResumable(row.status as BqImportStatus))
          assertTransition(row.status, "abandoned");
        if (row.version !== input.version) throw bqVersionConflict();
        const updated = await scope.tx.bqImport.updateMany({
          where: { tenantId: scope.access.tenantId, id: importId, version: input.version },
          data: { status: "abandoned", version: { increment: 1 } },
        });
        if (!updated.count) throw bqVersionConflict();
        await this.scope.audit(scope.tx, "bq.import.abandoned", importId, {
          projectId,
          from: row.status,
        });
        return this.detail(scope, await this.access.importRow(scope, projectId, importId));
      },
      true,
    );
  }

  /** The original upload, for people who may import (bq.import). */
  async source(principal: Principal, projectId: string, importId: string, req: Request) {
    const row = await this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.load(scope, projectId, "bq.import");
        const found = await this.access.importRow(scope, projectId, importId);
        await this.scope.audit(scope.tx, "bq.import.source_downloaded", importId, { projectId });
        return found;
      },
      true,
    );
    const content = await this.objects.getSource(row.sourceKey);
    if (createHash("sha256").update(content).digest("hex") !== row.fileSha256)
      throw new HttpException(
        { message: "The stored workbook does not match its checksum", code: "source-integrity" },
        500,
      );
    return { content, fileName: row.fileName, fileType: row.fileType as BqFileType };
  }
}
