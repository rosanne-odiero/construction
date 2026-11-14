import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import pdfmake from "pdfmake";
import * as XLSX from "xlsx";
import { contentDisposition, spreadsheetSafeText } from "@pm-buddy/domain";
import { messages, type Locale } from "@pm-buddy/i18n";
import { COMPLIANCE_STATUSES, DOCUMENT_LIMITS } from "@pm-buddy/types";
import type { ComplianceItem } from "@pm-buddy/validation";
import { AuthSecurity } from "../identity/auth-security.service.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { ComplianceService } from "./compliance.service.js";
import { DocumentsAccess } from "./documents-access.js";

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
const nairobiStamp = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Africa/Nairobi",
});
const day = (date: string | null) =>
  date ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : "—";

let pdfmakeReady = false;
/** Roboto in pdfmake's virtual file system; every URL and local file access denied (D-15). */
function preparePdfmake() {
  if (pdfmakeReady) return;
  const require = createRequire(import.meta.url);
  const fonts = join(dirname(require.resolve("pdfmake/package.json")), "fonts", "Roboto");
  for (const file of [
    "Roboto-Regular.ttf",
    "Roboto-Medium.ttf",
    "Roboto-Italic.ttf",
    "Roboto-MediumItalic.ttf",
  ])
    pdfmake.virtualfs.writeFileSync(file, readFileSync(join(fonts, file)));
  pdfmake.setFonts({
    Roboto: {
      normal: "Roboto-Regular.ttf",
      bold: "Roboto-Medium.ttf",
      italics: "Roboto-Italic.ttf",
      bolditalics: "Roboto-MediumItalic.ttf",
    },
  });
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);
  pdfmakeReady = true;
}

type ExportData = Awaited<ReturnType<ComplianceService["exportData"]>> & {
  companyName: string;
  generatedAt: Date;
};

/**
 * The project's compliance register as an A4 PDF (pdfmake) and as Excel (SheetJS), in English or
 * Kiswahili, generated on demand for a register reader (never stored or public; decision D-118).
 * The rows are the same as the screen's (statuses derived in Nairobi dates on the day of the
 * export); evidence in a confidential category is shown as restricted to readers without a finance
 * key. Text cells are neutralised against formula injection. Exports are rate-limited and audited.
 */
@Injectable()
export class ComplianceExportService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: DocumentsAccess,
    private readonly security: AuthSecurity,
    private readonly compliance: ComplianceService,
  ) {}

  private async load(
    principal: Principal,
    projectId: string,
    format: "pdf" | "xlsx",
    locale: Locale,
    req: Request,
  ): Promise<ExportData> {
    await this.security.limit(
      `compliance-export:${principal.user.id}`,
      DOCUMENT_LIMITS.exportsPer10Minutes,
      600,
    );
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.access.reader(scope, projectId);
        const data = await this.compliance.exportData(scope, caller, projectId);
        const tenant = await scope.tx.tenant.findUnique({
          where: { id: scope.access.tenantId },
          select: { name: true },
        });
        await this.scope.audit(scope.tx, "compliance.exported", projectId, {
          projectId,
          format,
          locale,
          items: data.items.length,
        });
        return { ...data, companyName: tenant?.name ?? "", generatedAt: new Date() };
      },
      true,
    );
  }

  private label(item: ComplianceItem, locale: Locale) {
    const types = messages(locale).documents.complianceTypes as Record<string, string>;
    return item.type.label ?? types[item.type.key] ?? item.type.key;
  }

  private rows(data: ExportData, locale: Locale) {
    const t = messages(locale).complianceExport;
    return data.items.map((item) => {
      const record = item.current;
      const evidence = !record?.evidence
        ? "—"
        : record.evidence.restricted
          ? t.evidenceRestricted
          : `${record.evidence.title} (${fill(t.revision, { revision: record.evidence.revision })}${
              record.evidence.state === "superseded" ? `, ${t.superseded}` : ""
            })`;
      return {
        item: `${this.label(item, locale)}${item.type.complianceReview ? " *" : ""}`,
        scope: t.scopes[item.type.scope],
        status: t.statuses[item.status],
        reference: record?.referenceNo ?? "—",
        issuer: record?.issuer ?? "—",
        issued: day(record?.issuedOn ?? null),
        expires: day(record?.expiresOn ?? null),
        daysLeft: item.daysLeft === null ? "—" : String(item.daysLeft),
        evidence,
        notes: record?.kind === "not_applicable" ? (record.reason ?? "") : (record?.notes ?? ""),
      };
    });
  }

  private fileName(data: ExportData, extension: string) {
    return `${data.project.code}-compliance-register-${data.today}.${extension}`;
  }

  async xlsx(principal: Principal, projectId: string, locale: Locale, req: Request) {
    const data = await this.load(principal, projectId, "xlsx", locale, req);
    const t = messages(locale).complianceExport;
    const text = (value: string) => ({ t: "s", v: spreadsheetSafeText(value) });
    const book = XLSX.utils.book_new();
    const rows: unknown[][] = [
      [text(t.title)],
      [text(t.company), text(data.companyName)],
      [text(t.project), text(`${data.project.code} – ${data.project.name}`)],
      [text(fill(t.asAt, { date: day(data.today) }))],
      [text(fill(t.generated, { date: nairobiStamp.format(data.generatedAt) }))],
      [],
      [text(t.summaryHeading)],
      ...COMPLIANCE_STATUSES.map((status) => [
        text(t.statuses[status]),
        { t: "n", v: data.counts[status] },
      ]),
      [],
      [
        text(t.columns.item),
        text(t.columns.scope),
        text(t.columns.status),
        text(t.columns.reference),
        text(t.columns.issuer),
        text(t.columns.issued),
        text(t.columns.expires),
        text(t.columns.daysLeft),
        text(t.columns.evidence),
        text(t.columns.notes),
      ],
      ...this.rows(data, locale).map((row) => [
        text(row.item),
        text(row.scope),
        text(row.status),
        text(row.reference),
        text(row.issuer),
        text(row.issued),
        text(row.expires),
        text(row.daysLeft),
        text(row.evidence),
        text(row.notes),
      ]),
      [],
      [text(t.reviewNote)],
      [text(t.datesNote)],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = [
      { wch: 40 },
      { wch: 12 },
      { wch: 16 },
      { wch: 18 },
      { wch: 24 },
      { wch: 12 },
      { wch: 12 },
      { wch: 10 },
      { wch: 36 },
      { wch: 40 },
    ];
    XLSX.utils.book_append_sheet(book, sheet, t.sheet);
    book.Props = { Title: t.title, Author: "PM-Buddy", Company: data.companyName };
    const content = XLSX.write(book, {
      type: "buffer",
      bookType: "xlsx",
      compression: true,
    }) as Buffer;
    return {
      content,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      disposition: contentDisposition(this.fileName(data, "xlsx")),
    };
  }

  async pdf(principal: Principal, projectId: string, locale: Locale, req: Request) {
    const data = await this.load(principal, projectId, "pdf", locale, req);
    preparePdfmake();
    const t = messages(locale).complianceExport;
    const th = (value: string) => ({ text: value, style: "th" });
    const tone: Record<string, string> = {
      missing: "#b45309",
      expiring: "#b45309",
      expired: "#b91c1c",
      valid: "#15803d",
      not_applicable: "#555555",
    };
    const body = [
      [
        th(t.columns.item),
        th(t.columns.status),
        th(t.columns.reference),
        th(t.columns.issued),
        th(t.columns.expires),
        th(t.columns.evidence),
        th(t.columns.notes),
      ],
      ...this.rows(data, locale).map((row, index) => [
        {
          stack: [
            { text: row.item, bold: true },
            { text: row.scope, fontSize: 7, color: "#555555" },
          ],
        },
        {
          stack: [
            { text: row.status, bold: true, color: tone[data.items[index]!.status] },
            ...(row.daysLeft !== "—"
              ? [{ text: fill(t.daysLeft, { days: row.daysLeft }), fontSize: 7 }]
              : []),
          ],
        },
        { stack: [row.reference, { text: row.issuer, fontSize: 7, color: "#555555" }] },
        row.issued,
        row.expires,
        row.evidence,
        row.notes,
      ]),
    ];
    const counts = COMPLIANCE_STATUSES.map(
      (status) => `${t.statuses[status]}: ${data.counts[status]}`,
    ).join("   ·   ");
    const definition = {
      pageSize: "A4",
      pageOrientation: "landscape",
      pageMargins: [32, 52, 32, 44],
      info: {
        title: `${t.title} – ${data.project.code}`,
        author: data.companyName,
        creator: "PM-Buddy",
      },
      defaultStyle: { font: "Roboto", fontSize: 8 },
      header: () => ({
        margin: [32, 20, 32, 0],
        columns: [
          { text: data.companyName, bold: true, fontSize: 8 },
          {
            text: `${data.project.code} · ${data.project.name}`,
            alignment: "right",
            fontSize: 8,
          },
        ],
      }),
      footer: (currentPage: number, pageCount: number) => ({
        margin: [32, 12, 32, 0],
        columns: [
          {
            text: fill(t.generated, { date: nairobiStamp.format(data.generatedAt) }),
            fontSize: 7,
            color: "#555555",
          },
          {
            text: fill(t.page, { page: currentPage, pages: pageCount }),
            alignment: "right",
            fontSize: 7,
          },
        ],
      }),
      content: [
        { text: t.title, style: "h1" },
        { text: `${t.project}: ${data.project.code} – ${data.project.name}` },
        { text: fill(t.asAt, { date: day(data.today) }), margin: [0, 2, 0, 0] },
        { text: counts, margin: [0, 8, 0, 8], bold: true },
        {
          table: {
            headerRows: 1,
            widths: [130, 70, 90, 50, 50, "*", 120],
            body,
          },
          layout: "lightHorizontalLines",
        },
        { text: t.reviewNote, fontSize: 7, margin: [0, 10, 0, 0], color: "#555555" },
        { text: t.datesNote, fontSize: 7, margin: [0, 2, 0, 0], color: "#555555" },
      ],
      styles: {
        h1: { fontSize: 16, bold: true, margin: [0, 0, 0, 4] },
        th: { bold: true, fillColor: "#eef2ff" },
      },
    };
    const content = await pdfmake.createPdf(definition).getBuffer();
    return {
      content,
      contentType: "application/pdf",
      disposition: contentDisposition(this.fileName(data, "pdf")),
    };
  }
}
