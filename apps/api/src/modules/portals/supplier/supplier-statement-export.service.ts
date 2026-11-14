import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import pdfmake from "pdfmake";
import * as XLSX from "xlsx";
import { contentDisposition, spreadsheetSafeText } from "@pm-buddy/domain";
import { messages, type Locale } from "@pm-buddy/i18n";
import { SUPPLIER_PORTAL_LIMITS } from "@pm-buddy/types";
import type { SupplierStatementResponse } from "@pm-buddy/validation";
import { formatMinor } from "../../bq/bq-export.service.js";
import { AuthSecurity } from "../../identity/auth-security.service.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { supplierPortalProblem } from "./supplier-portal-access.js";
import { SupplierPortalService } from "./supplier-portal.service.js";

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
const day = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

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

type Query = { projectId?: string; from?: string; to?: string };

/**
 * The supplier statement as an A4 PDF (pdfmake) and as Excel (SheetJS), in English or
 * Kiswahili, generated on demand for the supplier's own portal user (never stored), rate-limited
 * and audited. Payments are what the company recorded; the file says it is not a receipt and
 * shows no bank details. Text cells are neutralised against formula injection.
 */
@Injectable()
export class SupplierStatementExportService {
  constructor(
    private readonly scope: TenantScope,
    private readonly security: AuthSecurity,
    private readonly portal: SupplierPortalService,
  ) {}

  private async load(principal: Principal, query: Query, format: "pdf" | "xlsx", req: Request) {
    await this.security.limit(
      `supplier-statement-export:${principal.user.id}`,
      SUPPLIER_PORTAL_LIMITS.exportsPerTenMinutes,
      600,
    );
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const statement = await this.portal.statementOf(scope, query);
        if (
          format === "pdf" &&
          statement.entries.length > SUPPLIER_PORTAL_LIMITS.statementPdfMaxEntries
        )
          throw supplierPortalProblem(
            422,
            "statement-period-invalid",
            "This statement is too long for PDF; export Excel or choose a shorter period",
          );
        await this.scope.audit(
          scope.tx,
          "supplier_portal.statement_exported",
          statement.supplier.id,
          {
            format,
            projectId: statement.project?.id ?? null,
            entries: statement.entries.length,
          },
        );
        return statement;
      },
      true,
    );
  }

  private fileName(statement: SupplierStatementResponse, extension: string) {
    const scope = statement.project ? `-${statement.project.code}` : "";
    return `${statement.supplier.code}${scope}-statement-${statement.from}-${statement.to}.${extension}`;
  }

  private heading(statement: SupplierStatementResponse, locale: Locale) {
    const t = messages(locale).supplierStatementExport;
    return {
      t,
      lines: [
        `${t.supplier}: ${statement.supplier.code} – ${statement.supplier.name}`,
        `${t.customer}: ${statement.company.name}`,
        `${t.project}: ${statement.project ? `${statement.project.code} – ${statement.project.name}` : t.allProjects}`,
        fill(t.period, { from: day(statement.from), to: day(statement.to) }),
      ],
    };
  }

  private kind(entry: SupplierStatementResponse["entries"][number], locale: Locale) {
    const t = messages(locale).supplierStatementExport;
    if (entry.kind === "invoice") return fill(t.invoiceLine, { number: entry.invoiceNumber });
    return fill(t.paymentLine, {
      number: entry.invoiceNumber,
      method: entry.method ? t.methods[entry.method] : "",
      reference: entry.reference ?? "",
    });
  }

  async xlsx(principal: Principal, query: Query, locale: Locale, req: Request) {
    const statement = await this.load(principal, query, "xlsx", req);
    const { t, lines } = this.heading(statement, locale);
    const text = (value: string) => ({ t: "s", v: spreadsheetSafeText(value) });
    const money = (minor: number) => ({ t: "n", v: minor / 100, z: "#,##0.00" });
    const rows: unknown[][] = [
      [text(t.title)],
      ...lines.map((line) => [text(line)]),
      [text(fill(t.generated, { date: nairobiStamp.format(new Date(statement.generatedAt)) }))],
      [],
      [
        text(t.columns.date),
        text(t.columns.details),
        text(t.columns.invoiced),
        text(t.columns.paid),
        text(t.columns.balance),
      ],
      [text(day(statement.from)), text(t.opening), null, null, money(statement.openingMinor)],
      ...statement.entries.map((entry) => [
        text(day(entry.date)),
        text(this.kind(entry, locale)),
        entry.debitMinor ? money(entry.debitMinor) : null,
        entry.creditMinor ? money(entry.creditMinor) : null,
        money(entry.balanceMinor),
      ]),
      [
        text(day(statement.to)),
        text(t.closing),
        money(statement.invoicedMinor),
        money(statement.paidMinor),
        money(statement.closingMinor),
      ],
      [],
      [text(t.outstandingHeading)],
      [
        text(t.columns.invoice),
        text(t.columns.project),
        text(t.columns.dueDate),
        text(t.columns.total),
        text(t.columns.outstanding),
      ],
      ...statement.outstanding.map((row) => [
        text(row.overdue ? `${row.invoiceNumber} (${t.overdue})` : row.invoiceNumber),
        text(row.project.code),
        text(day(row.dueDate)),
        money(row.totalMinor),
        money(row.outstandingMinor),
      ]),
      [],
      [text(t.note)],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = [{ wch: 14 }, { wch: 56 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, t.sheet);
    book.Props = { Title: t.title, Author: "PM-Buddy", Company: statement.company.name };
    const content = XLSX.write(book, {
      type: "buffer",
      bookType: "xlsx",
      compression: true,
    }) as Buffer;
    return {
      content,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      disposition: contentDisposition(this.fileName(statement, "xlsx")),
    };
  }

  async pdf(principal: Principal, query: Query, locale: Locale, req: Request) {
    const statement = await this.load(principal, query, "pdf", req);
    preparePdfmake();
    const { t, lines } = this.heading(statement, locale);
    const right = (value: string, bold = false) => ({ text: value, alignment: "right", bold });
    const th = (value: string, alignment = "left") => ({ text: value, style: "th", alignment });
    const body = [
      [
        th(t.columns.date),
        th(t.columns.details),
        th(t.columns.invoiced, "right"),
        th(t.columns.paid, "right"),
        th(t.columns.balance, "right"),
      ],
      [day(statement.from), t.opening, "", "", right(formatMinor(statement.openingMinor))],
      ...statement.entries.map((entry) => [
        day(entry.date),
        this.kind(entry, locale),
        right(entry.debitMinor ? formatMinor(entry.debitMinor) : ""),
        right(entry.creditMinor ? formatMinor(entry.creditMinor) : ""),
        right(formatMinor(entry.balanceMinor)),
      ]),
      [
        { text: day(statement.to), bold: true },
        { text: t.closing, bold: true },
        right(formatMinor(statement.invoicedMinor), true),
        right(formatMinor(statement.paidMinor), true),
        right(formatMinor(statement.closingMinor), true),
      ],
    ];
    const outstanding = [
      [
        th(t.columns.invoice),
        th(t.columns.project),
        th(t.columns.dueDate),
        th(t.columns.total, "right"),
        th(t.columns.outstanding, "right"),
      ],
      ...statement.outstanding.map((row) => [
        row.overdue ? `${row.invoiceNumber} (${t.overdue})` : row.invoiceNumber,
        row.project.code,
        day(row.dueDate),
        right(formatMinor(row.totalMinor)),
        right(formatMinor(row.outstandingMinor)),
      ]),
    ];
    const definition = {
      pageSize: "A4",
      pageMargins: [36, 56, 36, 48],
      info: { title: t.title, author: statement.company.name, creator: "PM-Buddy" },
      defaultStyle: { font: "Roboto", fontSize: 8.5 },
      header: () => ({
        margin: [36, 22, 36, 0],
        columns: [
          { text: statement.company.name, bold: true, fontSize: 8 },
          { text: statement.supplier.name, alignment: "right", fontSize: 8 },
        ],
      }),
      footer: (currentPage: number, pageCount: number) => ({
        margin: [36, 14, 36, 0],
        columns: [
          {
            text: fill(t.generated, {
              date: nairobiStamp.format(new Date(statement.generatedAt)),
            }),
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
        ...lines.map((line) => ({ text: line })),
        { text: `${t.currency}: KES`, margin: [0, 0, 0, 6] },
        {
          table: { headerRows: 1, widths: [52, "*", 70, 70, 74], body },
          layout: "lightHorizontalLines",
        },
        { text: t.outstandingHeading, style: "h2" },
        statement.outstanding.length
          ? {
              table: { headerRows: 1, widths: [90, 60, 60, "*", 80], body: outstanding },
              layout: "lightHorizontalLines",
            }
          : { text: t.nothingOutstanding, italics: true },
        { text: t.note, fontSize: 7.5, color: "#555555", margin: [0, 12, 0, 0] },
      ],
      styles: {
        h1: { fontSize: 16, bold: true, margin: [0, 0, 0, 6] },
        h2: { fontSize: 11, bold: true, margin: [0, 12, 0, 5] },
        th: { bold: true, fillColor: "#eef2ff" },
      },
    };
    const content = await pdfmake.createPdf(definition).getBuffer();
    return {
      content,
      contentType: "application/pdf",
      disposition: contentDisposition(this.fileName(statement, "pdf")),
    };
  }
}
