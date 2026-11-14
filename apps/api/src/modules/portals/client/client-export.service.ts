import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import pdfmake from "pdfmake";
import * as XLSX from "xlsx";
import { contentDisposition, spreadsheetSafeText } from "@pm-buddy/domain";
import { messages, type Locale } from "@pm-buddy/i18n";
import { CLIENT_PORTAL_LIMITS } from "@pm-buddy/types";
import type { ClientStatementResponse } from "@pm-buddy/validation";
import { formatMinor } from "../../bq/bq-export.service.js";
import type { Scope } from "../../identity/access-policy.js";
import { AuthSecurity } from "../../identity/auth-security.service.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { CertificateExportService } from "../../progress/valuations/certificate-export.service.js";
import { ValuationsService } from "../../progress/valuations/valuations.service.js";
import { ClientPortalAccess, clientPortalProblem } from "./client-portal-access.js";
import { ClientPortalService } from "./client-portal.service.js";

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
const signed = (minor: number) => (minor < 0 ? `(${formatMinor(-minor)})` : formatMinor(minor));

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

/**
 * Client downloads (D7.1): the client statement as an A4 PDF (pdfmake) and as Excel (SheetJS),
 * in English or Kiswahili, and a CERTIFIED certificate as the D6.3 PDF. Generated on demand for
 * the client of the project or its finance staff (never stored or public), rate-limited and
 * audited; amounts in KES only (an FX display never reaches a document). Text cells are
 * neutralised against formula injection; amounts stay numeric.
 */
@Injectable()
export class ClientExportService {
  constructor(
    private readonly scope: TenantScope,
    private readonly security: AuthSecurity,
    private readonly access: ClientPortalAccess,
    private readonly portal: ClientPortalService,
    private readonly valuations: ValuationsService,
    private readonly certificates: CertificateExportService,
  ) {}

  private async limit(principal: Principal) {
    await this.security.limit(
      `client-export:${principal.user.id}`,
      CLIENT_PORTAL_LIMITS.exportsPerTenMinutes,
      600,
    );
  }

  /** A certified certificate of the client's project as the D6.3 PDF (never a draft). */
  async certificatePdf(
    principal: Principal,
    projectId: string,
    valuationId: string,
    locale: Locale,
    req: Request,
  ) {
    await this.limit(principal);
    const data = await this.scope.run(
      principal,
      req,
      async (scope: Scope) => {
        const project = await this.access.project(scope, projectId);
        const row = await scope.tx.valuation.findFirst({
          where: {
            tenantId: scope.access.tenantId,
            projectId,
            id: valuationId,
            status: "certified",
          },
          select: { id: true },
        });
        if (!row) throw new NotFoundException("Certificate not found");
        const valuation = await this.valuations.detailOf(scope, row.id);
        const tenant = await scope.tx.tenant.findUniqueOrThrow({
          where: { id: scope.access.tenantId },
          select: { name: true },
        });
        await this.scope.audit(scope.tx, "client_portal.certificate_downloaded", row.id, {
          projectId,
        });
        return {
          companyName: tenant.name,
          clientName: project.clientName,
          valuation,
          generatedAt: new Date(),
        };
      },
      true,
    );
    return this.certificates.renderPdf(data, locale);
  }

  private async load(
    principal: Principal,
    projectId: string,
    format: "pdf" | "xlsx",
    staff: boolean,
    req: Request,
  ): Promise<ClientStatementResponse> {
    await this.limit(principal);
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const statement = await this.portal.statementOf(scope, projectId, "KES", staff);
        if (
          format === "pdf" &&
          statement.entries.length > CLIENT_PORTAL_LIMITS.statementPdfMaxEntries
        )
          throw clientPortalProblem(
            422,
            "export-too-large",
            "This statement is too long for PDF; export Excel instead",
          );
        await this.scope.audit(scope.tx, "client_portal.statement_exported", projectId, {
          format,
          by: staff ? "staff" : "client",
          entries: statement.entries.length,
        });
        return statement;
      },
      true,
    );
  }

  private fileName(statement: ClientStatementResponse, extension: string) {
    return `${statement.project.code}-client-statement-${statement.today}.${extension}`;
  }

  private details(entry: ClientStatementResponse["entries"][number], locale: Locale) {
    const t = messages(locale).clientStatementExport;
    return fill(t.lines[entry.kind], { number: entry.certificateNumber });
  }

  private heading(statement: ClientStatementResponse, locale: Locale) {
    const t = messages(locale).clientStatementExport;
    return [
      `${t.contractor}: ${statement.company.name}`,
      `${t.project}: ${statement.project.code} – ${statement.project.name}`,
      ...(statement.clientName ? [`${t.client}: ${statement.clientName}`] : []),
      fill(t.asOf, { date: day(statement.today) }),
    ];
  }

  /** `staff`: exported by the company's valuation or finance readers rather than the client. */
  async xlsx(
    principal: Principal,
    projectId: string,
    locale: Locale,
    staff: boolean,
    req: Request,
  ) {
    const statement = await this.load(principal, projectId, "xlsx", staff, req);
    const t = messages(locale).clientStatementExport;
    const text = (value: string) => ({ t: "s", v: spreadsheetSafeText(value) });
    const money = (minor: number) => ({ t: "n", v: minor / 100, z: "#,##0.00" });
    const rows: unknown[][] = [
      [text(t.title)],
      ...this.heading(statement, locale).map((line) => [text(line)]),
      [text(fill(t.generated, { date: nairobiStamp.format(new Date(statement.generatedAt)) }))],
      [text(`${t.currency}: KES`)],
      [],
      [
        text(t.columns.date),
        text(t.columns.details),
        text(t.columns.certified),
        text(t.columns.received),
        text(t.columns.balance),
      ],
      ...statement.entries.map((entry) => [
        text(day(entry.date)),
        text(this.details(entry, locale)),
        entry.kind === "receipt" ? null : money(entry.debitMinor - entry.creditMinor),
        entry.kind === "receipt" ? money(entry.creditMinor) : null,
        money(entry.balanceMinor),
      ]),
      [
        text(day(statement.today)),
        text(t.closing),
        money(statement.totals.certifiedMinor),
        money(statement.totals.receivedMinor),
        money(statement.totals.outstandingMinor),
      ],
      [],
      [text(t.certificatesHeading)],
      [
        text(t.columns.certificate),
        text(t.columns.certifiedOn),
        text(t.columns.dueDate),
        text(t.columns.total),
        text(t.columns.received),
        text(t.columns.outstanding),
        text(t.columns.status),
      ],
      ...statement.certificates.map((row) => [
        text(row.number),
        text(day(row.certifiedOn)),
        text(day(row.dueDate)),
        money(row.totalMinor),
        money(row.receivedMinor),
        money(row.outstandingMinor),
        text(
          row.overdue
            ? fill(t.overdue, { days: row.overdueDays, state: t.states[row.state] })
            : t.states[row.state],
        ),
      ]),
      [],
      [text(t.receiptsHeading)],
      [
        text(t.columns.date),
        text(t.columns.certificate),
        text(t.columns.method),
        text(t.columns.reference),
        text(t.columns.amount),
      ],
      ...statement.receipts.map((row) => [
        text(day(row.receivedOn)),
        text(row.certificateNumber),
        text(
          row.kind === "reversal"
            ? fill(t.reversal, { reason: row.reason ?? "" })
            : t.methods[row.method!],
        ),
        text(row.reference ?? ""),
        money(row.kind === "reversal" ? -row.amountMinor : row.amountMinor),
      ]),
      [],
      [text(t.note)],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = [
      { wch: 14 },
      { wch: 44 },
      { wch: 16 },
      { wch: 18 },
      { wch: 18 },
      { wch: 18 },
      { wch: 22 },
    ];
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

  async pdf(principal: Principal, projectId: string, locale: Locale, staff: boolean, req: Request) {
    const statement = await this.load(principal, projectId, "pdf", staff, req);
    preparePdfmake();
    const t = messages(locale).clientStatementExport;
    const right = (value: string, bold = false) => ({ text: value, alignment: "right", bold });
    const th = (value: string, alignment = "left") => ({ text: value, style: "th", alignment });
    const body = [
      [
        th(t.columns.date),
        th(t.columns.details),
        th(t.columns.certified, "right"),
        th(t.columns.received, "right"),
        th(t.columns.balance, "right"),
      ],
      ...statement.entries.map((entry) => [
        day(entry.date),
        this.details(entry, locale),
        right(entry.kind === "receipt" ? "" : signed(entry.debitMinor - entry.creditMinor)),
        right(entry.kind === "receipt" ? formatMinor(entry.creditMinor) : ""),
        right(signed(entry.balanceMinor)),
      ]),
      [
        { text: day(statement.today), bold: true },
        { text: t.closing, bold: true },
        right(signed(statement.totals.certifiedMinor), true),
        right(formatMinor(statement.totals.receivedMinor), true),
        right(signed(statement.totals.outstandingMinor), true),
      ],
    ];
    const certificates = [
      [
        th(t.columns.certificate),
        th(t.columns.dueDate),
        th(t.columns.total, "right"),
        th(t.columns.received, "right"),
        th(t.columns.outstanding, "right"),
        th(t.columns.status),
      ],
      ...statement.certificates.map((row) => [
        row.number,
        day(row.dueDate),
        right(signed(row.totalMinor)),
        right(formatMinor(row.receivedMinor)),
        right(formatMinor(row.outstandingMinor)),
        row.overdue
          ? fill(t.overdue, { days: row.overdueDays, state: t.states[row.state] })
          : t.states[row.state],
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
          { text: statement.project.code, alignment: "right", fontSize: 8 },
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
        ...this.heading(statement, locale).map((line) => ({ text: line })),
        { text: `${t.currency}: KES`, margin: [0, 0, 0, 6] },
        {
          table: { headerRows: 1, widths: [52, "*", 74, 74, 78], body },
          layout: "lightHorizontalLines",
        },
        { text: t.certificatesHeading, style: "h2" },
        statement.certificates.length
          ? {
              table: { headerRows: 1, widths: [56, 56, 72, 72, 72, "*"], body: certificates },
              layout: "lightHorizontalLines",
            }
          : { text: t.noCertificates, italics: true },
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
