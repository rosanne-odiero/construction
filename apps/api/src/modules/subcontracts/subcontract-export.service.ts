import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import pdfmake from "pdfmake";
import * as XLSX from "xlsx";
import { contentDisposition, spreadsheetSafeText } from "@pm-buddy/domain";
import { messages, type Locale } from "@pm-buddy/i18n";
import { SUBCONTRACT_LIMITS } from "@pm-buddy/types";
import type { SubcontractCertificateDetail, SubcontractDetail } from "@pm-buddy/validation";
import { formatDecimal, formatMinor } from "../bq/bq-export.service.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { SubcontractCertificatesService } from "./subcontract-certificates.service.js";
import { SubcontractsService } from "./subcontracts.service.js";
import { subcontractProblem } from "./subcontracts-common.js";

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

type File = { content: Buffer; contentType: string; disposition: string };
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const text = (value: string) => ({ t: "s", v: spreadsheetSafeText(value) });
const money = (minor: number) => ({ t: "n", v: minor / 100, z: "#,##0.00" });
const kes = (minor: number) => `KES ${formatMinor(minor)}`;

/**
 * Subcontract payment certificates and the subcontractor statement as A4 PDF (pdfmake) and Excel
 * (SheetJS), in English or Kiswahili, generated on demand for a subcontract reader (never stored
 * or public), rate-limited and audited. A certificate that is not certified carries a "not
 * certified" watermark. Text cells are neutralised against formula injection; amounts stay
 * numeric.
 */
@Injectable()
export class SubcontractExportService {
  constructor(
    private readonly scope: TenantScope,
    private readonly security: AuthSecurity,
    private readonly subcontracts: SubcontractsService,
    private readonly certificates: SubcontractCertificatesService,
  ) {}

  private async loadCertificate(
    principal: Principal,
    id: string,
    format: "pdf" | "xlsx",
    req: Request,
  ) {
    await this.security.limit(`subcontract-export:${principal.user.id}`, 60, 600);
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const certificate = await this.certificates.detailOf(scope, id);
        if (format === "pdf" && certificate.lines.length > SUBCONTRACT_LIMITS.pdfMaxLines)
          throw subcontractProblem(
            422,
            "export-too-large",
            "This certificate is too large for PDF; export Excel instead",
          );
        const tenant = await scope.tx.tenant.findUnique({
          where: { id: scope.access.tenantId },
          select: { name: true },
        });
        await this.scope.audit(scope.tx, "subcontract.certificate_exported", id, {
          projectId: certificate.project.id,
          format,
          status: certificate.status,
        });
        return { companyName: tenant?.name ?? "", certificate, generatedAt: new Date() };
      },
      true,
      30_000,
    );
  }

  private async loadStatement(
    principal: Principal,
    id: string,
    format: "pdf" | "xlsx",
    req: Request,
  ) {
    await this.security.limit(`subcontract-export:${principal.user.id}`, 60, 600);
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const subcontract = await this.subcontracts.detailOf(scope, id);
        const tenant = await scope.tx.tenant.findUnique({
          where: { id: scope.access.tenantId },
          select: { name: true },
        });
        await this.scope.audit(scope.tx, "subcontract.statement_exported", id, {
          projectId: subcontract.project.id,
          format,
        });
        return { companyName: tenant?.name ?? "", subcontract, generatedAt: new Date() };
      },
      true,
      30_000,
    );
  }

  // Certificates -------------------------------------------------------------------------------

  private title(certificate: SubcontractCertificateDetail, locale: Locale) {
    const t = messages(locale).subcontractExport;
    if (certificate.status !== "certified") return t.notCertifiedTitle;
    return certificate.kind === "retention_release" ? t.releaseTitle : t.certificateTitle;
  }

  private summary(certificate: SubcontractCertificateDetail, locale: Locale) {
    const t = messages(locale).subcontractExport;
    const { figures, terms } = certificate;
    const limit =
      figures.retentionLimitMinor === null
        ? ""
        : fill(t.retentionLimit, { amount: kes(figures.retentionLimitMinor) });
    return [
      { label: t.workDone, amount: figures.workDoneMinor, strong: true },
      {
        label:
          figures.retentionStage === "none"
            ? fill(t.retention, { percent: terms.retentionPercent, limit })
            : fill(t.retentionReleased, { stage: t.stages[figures.retentionStage] }),
        amount: -figures.retentionHeldMinor,
      },
      {
        label: fill(t.recovery, { percent: terms.advanceRecoveryPercent }),
        amount: -figures.recoveredToDateMinor,
      },
      { label: t.net, amount: figures.netToDateMinor, strong: true },
      { label: t.previous, amount: -figures.previousCertifiedMinor },
      { label: t.amountDue, amount: figures.amountDueMinor, strong: true },
      { label: fill(t.vat, { rate: terms.vatPercent }), amount: figures.vatMinor },
      { label: fill(t.wht, { rate: terms.whtPercent }), amount: -figures.whtMinor },
      { label: t.payable, amount: figures.payableMinor, strong: true },
    ];
  }

  private certificateName(certificate: SubcontractCertificateDetail, extension: string) {
    return `${certificate.project.code}-${certificate.subcontract.code}-${certificate.code}-${certificate.status}.${extension}`;
  }

  async certificateXlsx(
    principal: Principal,
    id: string,
    locale: Locale,
    req: Request,
  ): Promise<File> {
    const data = await this.loadCertificate(principal, id, "xlsx", req);
    const t = messages(locale).subcontractExport;
    const { certificate } = data;
    const book = XLSX.utils.book_new();
    const head: unknown[][] = [
      [text(this.title(certificate, locale))],
      [text(t.company), text(data.companyName)],
      [text(t.project), text(`${certificate.project.code} – ${certificate.project.name}`)],
      [
        text(t.subcontract),
        text(`${certificate.subcontract.code} – ${certificate.subcontract.title}`),
      ],
      [text(t.subcontractor), text(certificate.subcontract.supplier.name)],
      [text(t.kraPin), text(certificate.subcontract.supplier.kraPinMasked ?? "—")],
      [text(t.certificate), text(`${certificate.code} · ${t.status[certificate.status]}`)],
      [text(t.valuationDate), text(day(certificate.valuationDate))],
      [text(fill(t.generated, { date: nairobiStamp.format(data.generatedAt) }))],
      [],
      [text(t.summaryHeading)],
      ...this.summary(certificate, locale).map((row) => [text(row.label), money(row.amount)]),
      [],
      [text(t.netNote)],
      [
        text(
          fill(t.rule, {
            rule: certificate.ruleVersion,
            version: certificate.subcontract.contractVersion,
          }),
        ),
      ],
      [text(t.review)],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(head);
    sheet["!cols"] = [{ wch: 52 }, { wch: 24 }];
    XLSX.utils.book_append_sheet(book, sheet, t.summarySheet);
    const lines: unknown[][] = [
      [
        text(t.columns.ref),
        text(t.columns.description),
        text(t.columns.unit),
        text(t.columns.lineQuantity),
        text(t.columns.rate),
        text(t.columns.measured),
        text(t.columns.quantity),
        text(t.columns.previous),
        text(t.columns.thisPeriod),
        text(t.columns.toDate),
      ],
      ...certificate.lines.map((line) => [
        text(line.bqItem.ref ?? ""),
        text(line.description),
        text(line.basis === "percent" ? "%" : (line.unit ?? "")),
        { t: "n", v: Number(line.lineQuantity) },
        line.rateMinor === null ? money(line.lineAmountMinor) : money(line.rateMinor),
        line.measuredToDate === null ? null : { t: "n", v: Number(line.measuredToDate) },
        { t: "n", v: Number(line.quantityToDate) },
        money(line.previousMinor),
        money(line.thisPeriodMinor),
        money(line.valueToDateMinor),
      ]),
    ];
    const lineSheet = XLSX.utils.aoa_to_sheet(lines);
    lineSheet["!cols"] = [8, 48, 6, 12, 14, 12, 12, 16, 16, 16].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(book, lineSheet, t.linesSheet);
    book.Props = {
      Title: this.title(certificate, locale),
      Author: "PM-Buddy",
      Company: data.companyName,
    };
    return {
      content: XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer,
      contentType: XLSX_TYPE,
      disposition: contentDisposition(this.certificateName(certificate, "xlsx")),
    };
  }

  async certificatePdf(
    principal: Principal,
    id: string,
    locale: Locale,
    req: Request,
  ): Promise<File> {
    const data = await this.loadCertificate(principal, id, "pdf", req);
    preparePdfmake();
    const t = messages(locale).subcontractExport;
    const { certificate } = data;
    const right = (value: string, bold = false) => ({ text: value, alignment: "right", bold });
    const th = (value: string, alignment = "left") => ({ text: value, style: "th", alignment });
    const summaryBody = this.summary(certificate, locale).map((row) => [
      { text: row.label, bold: row.strong ?? false },
      right(kes(row.amount), row.strong ?? false),
    ]);
    const lineBody = [
      [
        th(t.columns.ref),
        th(t.columns.description),
        th(t.columns.quantity, "right"),
        th(t.columns.rate, "right"),
        th(t.columns.previous, "right"),
        th(t.columns.thisPeriod, "right"),
        th(t.columns.toDate, "right"),
      ],
      ...certificate.lines.map((line) => [
        line.bqItem.ref ?? "",
        line.description,
        right(
          `${formatDecimal(line.quantityToDate)} ${line.basis === "percent" ? "%" : (line.unit ?? "")}`,
        ),
        right(
          line.rateMinor === null ? formatMinor(line.lineAmountMinor) : formatMinor(line.rateMinor),
        ),
        right(formatMinor(line.previousMinor)),
        right(formatMinor(line.thisPeriodMinor)),
        right(formatMinor(line.valueToDateMinor)),
      ]),
    ];
    const signature = (role: string, name: string | null) => ({
      stack: [
        { text: role, bold: true, fontSize: 8 },
        { text: name ?? " ", margin: [0, 4, 0, 0] },
        { canvas: [{ type: "line", x1: 0, y1: 18, x2: 150, y2: 18, lineWidth: 0.6 }] },
        { text: t.nameDate, fontSize: 7, color: "#555555", margin: [0, 2, 0, 0] },
      ],
    });
    const definition = {
      pageSize: "A4",
      pageMargins: [36, 56, 36, 48],
      info: {
        title: `${this.title(certificate, locale)} – ${certificate.subcontract.code}`,
        author: data.companyName,
        creator: "PM-Buddy",
      },
      defaultStyle: { font: "Roboto", fontSize: 8.5 },
      ...(certificate.status === "certified"
        ? {}
        : { watermark: { text: t.watermark, color: "#b91c1c", opacity: 0.1, bold: true } }),
      header: () => ({
        margin: [36, 22, 36, 0],
        columns: [
          { text: data.companyName, bold: true, fontSize: 8 },
          {
            text: `${certificate.project.code} · ${certificate.subcontract.code}`,
            alignment: "right",
            fontSize: 8,
          },
        ],
      }),
      footer: (currentPage: number, pageCount: number) => ({
        margin: [36, 14, 36, 0],
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
        { text: this.title(certificate, locale), style: "h1" },
        { text: `${certificate.code} · ${t.status[certificate.status]}`, bold: true },
        {
          stack: [
            { text: `${t.project}: ${certificate.project.code} – ${certificate.project.name}` },
            {
              text: `${t.subcontract}: ${certificate.subcontract.code} – ${certificate.subcontract.title}`,
            },
            {
              text: `${t.subcontractor}: ${certificate.subcontract.supplier.name} (${t.kraPin} ${certificate.subcontract.supplier.kraPinMasked ?? "—"})`,
            },
            { text: `${t.valuationDate}: ${day(certificate.valuationDate)}` },
          ],
          margin: [0, 6, 0, 0],
        },
        { text: t.summaryHeading, style: "h2" },
        { table: { widths: ["*", 130], body: summaryBody }, layout: "lightHorizontalLines" },
        { text: t.netNote, italics: true, color: "#555555", margin: [0, 6, 0, 0] },
        {
          text: fill(t.rule, {
            rule: certificate.ruleVersion,
            version: certificate.subcontract.contractVersion,
          }),
          fontSize: 7.5,
          color: "#555555",
        },
        { text: t.review, fontSize: 7.5, color: "#555555" },
        { text: t.signatures, style: "h2" },
        {
          columns: [
            signature(
              t.preparedBy,
              certificate.submittedBy?.displayName ?? certificate.createdBy.displayName,
            ),
            signature(t.certifiedBy, certificate.certifiedBy?.displayName ?? null),
            signature(t.receivedBy, null),
          ],
          columnGap: 14,
        },
        ...(certificate.lines.length
          ? [
              { text: t.linesHeading, style: "h2", pageBreak: "before" },
              {
                table: {
                  headerRows: 1,
                  dontBreakRows: true,
                  widths: [28, "*", 62, 56, 60, 60, 62],
                  body: lineBody,
                },
                layout: "lightHorizontalLines",
              },
            ]
          : []),
      ],
      styles: {
        h1: { fontSize: 16, bold: true, margin: [0, 0, 0, 4] },
        h2: { fontSize: 11, bold: true, margin: [0, 12, 0, 5] },
        th: { bold: true, fillColor: "#eef2ff" },
      },
    };
    const content = await pdfmake.createPdf(definition).getBuffer();
    return {
      content,
      contentType: "application/pdf",
      disposition: contentDisposition(this.certificateName(certificate, "pdf")),
    };
  }

  // Statements ---------------------------------------------------------------------------------

  private statementRows(subcontract: SubcontractDetail, locale: Locale) {
    const t = messages(locale).subcontractExport;
    const p = subcontract.position;
    return [
      { label: t.statement.value, amount: subcontract.valueMinor },
      { label: t.statement.certifiedWork, amount: p.certifiedWorkMinor },
      { label: t.statement.retentionHeld, amount: p.retentionHeldMinor },
      { label: t.statement.advancesPaid, amount: p.advancesPaidMinor },
      { label: t.statement.advancesRecovered, amount: p.advancesRecoveredMinor },
      { label: t.statement.advancesOutstanding, amount: p.advancesOutstandingMinor },
      { label: t.statement.certifiedDue, amount: p.certifiedDueMinor },
      { label: t.statement.vat, amount: p.vatMinor },
      { label: t.statement.wht, amount: p.whtMinor },
      { label: t.statement.payable, amount: p.payableMinor },
      { label: t.statement.paid, amount: p.paidMinor },
      { label: t.statement.outstanding, amount: p.outstandingMinor },
    ];
  }

  private statementName(subcontract: SubcontractDetail, extension: string) {
    return `${subcontract.project.code}-${subcontract.code}-statement.${extension}`;
  }

  async statementXlsx(
    principal: Principal,
    id: string,
    locale: Locale,
    req: Request,
  ): Promise<File> {
    const data = await this.loadStatement(principal, id, "xlsx", req);
    const t = messages(locale).subcontractExport;
    const { subcontract } = data;
    const book = XLSX.utils.book_new();
    const rows: unknown[][] = [
      [text(t.statement.title)],
      [text(t.company), text(data.companyName)],
      [text(t.project), text(`${subcontract.project.code} – ${subcontract.project.name}`)],
      [text(t.subcontract), text(`${subcontract.code} – ${subcontract.title}`)],
      [text(t.subcontractor), text(subcontract.supplier.name)],
      [text(t.kraPin), text(subcontract.supplier.kraPinMasked ?? "—")],
      [text(fill(t.generated, { date: nairobiStamp.format(data.generatedAt) }))],
      [],
      ...this.statementRows(subcontract, locale).map((row) => [text(row.label), money(row.amount)]),
      [],
      [text(t.statement.certificatesHeading)],
      [
        text(t.columns.certificate),
        text(t.valuationDate),
        text(t.columns.status),
        text(t.columns.toDate),
        text(t.amountDue),
        text(t.payable),
        text(t.statement.paid),
      ],
      ...subcontract.certificates.map((entry) => [
        text(entry.code),
        text(day(entry.valuationDate)),
        text(t.status[entry.status]),
        entry.workDoneMinor === null ? null : money(entry.workDoneMinor),
        entry.amountDueMinor === null ? null : money(entry.amountDueMinor),
        entry.payableMinor === null ? null : money(entry.payableMinor),
        money(entry.paidMinor),
      ]),
      [],
      [text(t.statement.advancesHeading)],
      ...subcontract.advances.map((entry) => [
        text(entry.code),
        text(t.advanceStatus[entry.status]),
        money(entry.amountMinor),
        text(entry.paidOn ? day(entry.paidOn) : ""),
        text(entry.reference ?? ""),
      ]),
      [],
      [text(t.statement.note)],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = [
      { wch: 44 },
      { wch: 18 },
      { wch: 22 },
      { wch: 18 },
      { wch: 18 },
      { wch: 18 },
      { wch: 18 },
    ];
    XLSX.utils.book_append_sheet(book, sheet, t.statement.sheet);
    book.Props = { Title: t.statement.title, Author: "PM-Buddy", Company: data.companyName };
    return {
      content: XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer,
      contentType: XLSX_TYPE,
      disposition: contentDisposition(this.statementName(subcontract, "xlsx")),
    };
  }

  async statementPdf(
    principal: Principal,
    id: string,
    locale: Locale,
    req: Request,
  ): Promise<File> {
    const data = await this.loadStatement(principal, id, "pdf", req);
    preparePdfmake();
    const t = messages(locale).subcontractExport;
    const { subcontract } = data;
    const right = (value: string) => ({ text: value, alignment: "right" });
    const th = (value: string, alignment = "left") => ({ text: value, style: "th", alignment });
    const definition = {
      pageSize: "A4",
      pageMargins: [36, 56, 36, 48],
      info: {
        title: `${t.statement.title} – ${subcontract.code}`,
        author: data.companyName,
        creator: "PM-Buddy",
      },
      defaultStyle: { font: "Roboto", fontSize: 8.5 },
      header: () => ({
        margin: [36, 22, 36, 0],
        columns: [
          { text: data.companyName, bold: true, fontSize: 8 },
          {
            text: `${subcontract.project.code} · ${subcontract.code}`,
            alignment: "right",
            fontSize: 8,
          },
        ],
      }),
      footer: (currentPage: number, pageCount: number) => ({
        margin: [36, 14, 36, 0],
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
        { text: t.statement.title, style: "h1" },
        {
          stack: [
            { text: `${t.project}: ${subcontract.project.code} – ${subcontract.project.name}` },
            { text: `${t.subcontract}: ${subcontract.code} – ${subcontract.title}` },
            {
              text: `${t.subcontractor}: ${subcontract.supplier.name} (${t.kraPin} ${subcontract.supplier.kraPinMasked ?? "—"})`,
            },
          ],
        },
        { text: t.summaryHeading, style: "h2" },
        {
          table: {
            widths: ["*", 130],
            body: this.statementRows(subcontract, locale).map((row) => [
              row.label,
              right(kes(row.amount)),
            ]),
          },
          layout: "lightHorizontalLines",
        },
        { text: t.statement.certificatesHeading, style: "h2" },
        {
          table: {
            headerRows: 1,
            widths: [60, 55, "*", 70, 70, 70],
            body: [
              [
                th(t.columns.certificate),
                th(t.valuationDate),
                th(t.columns.status),
                th(t.amountDue, "right"),
                th(t.payable, "right"),
                th(t.statement.paid, "right"),
              ],
              ...subcontract.certificates.map((entry) => [
                entry.code,
                day(entry.valuationDate),
                t.status[entry.status],
                right(entry.amountDueMinor === null ? "—" : formatMinor(entry.amountDueMinor)),
                right(entry.payableMinor === null ? "—" : formatMinor(entry.payableMinor)),
                right(formatMinor(entry.paidMinor)),
              ]),
            ],
          },
          layout: "lightHorizontalLines",
        },
        { text: t.statement.advancesHeading, style: "h2" },
        {
          table: {
            headerRows: 1,
            widths: [50, 70, 70, 60, "*"],
            body: [
              [
                th(t.columns.advance),
                th(t.columns.status),
                th(t.columns.amount, "right"),
                th(t.columns.paidOn),
                th(t.columns.reference),
              ],
              ...subcontract.advances.map((entry) => [
                entry.code,
                t.advanceStatus[entry.status],
                right(formatMinor(entry.amountMinor)),
                entry.paidOn ? day(entry.paidOn) : "",
                entry.reference ?? "",
              ]),
            ],
          },
          layout: "lightHorizontalLines",
        },
        { text: t.statement.note, italics: true, color: "#555555", margin: [0, 8, 0, 0] },
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
      disposition: contentDisposition(this.statementName(subcontract, "pdf")),
    };
  }
}
