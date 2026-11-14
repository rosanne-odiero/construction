import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import pdfmake from "pdfmake";
import * as XLSX from "xlsx";
import { contentDisposition, spreadsheetSafeText } from "@pm-buddy/domain";
import { messages, type Locale } from "@pm-buddy/i18n";
import { VALUATION_READ_PERMISSIONS } from "@pm-buddy/types";
import type { ValuationDetail } from "@pm-buddy/validation";
import { formatDecimal, formatMinor } from "../../bq/bq-export.service.js";
import { SpendingAccess } from "../../finance/spending-common.js";
import { AuthSecurity } from "../../identity/auth-security.service.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { valuationProblem } from "./valuation-common.js";
import { ValuationsService } from "./valuations.service.js";

/** PDFs above this many lines are refused (Excel has no such limit); rendering is in-process. */
export const CERTIFICATE_PDF_MAX_LINES = 5_000;

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

export type CertificateExportData = {
  companyName: string;
  clientName: string | null;
  valuation: ValuationDetail;
  generatedAt: Date;
};

/**
 * The payment certificate as an A4 PDF (pdfmake) and as Excel (SheetJS), in English or Kiswahili,
 * generated on demand for a valuation reader (never stored or public). A valuation that is not
 * certified carries a "not certified" watermark. Text cells are neutralised against formula
 * injection; amounts stay numeric.
 */
@Injectable()
export class CertificateExportService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SpendingAccess,
    private readonly security: AuthSecurity,
    private readonly valuations: ValuationsService,
  ) {}

  private async load(
    principal: Principal,
    id: string,
    format: "pdf" | "xlsx",
    req: Request,
  ): Promise<CertificateExportData> {
    await this.security.limit(`ipc-export:${principal.user.id}`, 60, 600);
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const row = await this.valuations.row(scope, id);
        const project = await this.access.on(scope, row.projectId);
        if (!this.access.holds(project, VALUATION_READ_PERMISSIONS))
          throw new ForbiddenException("No permission to see valuations on this project");
        const valuation = await this.valuations.detailOf(scope, id);
        const lines =
          valuation.lines.items.length +
          valuation.lines.materials.length +
          valuation.lines.adjustments.length;
        if (format === "pdf" && lines > CERTIFICATE_PDF_MAX_LINES)
          throw valuationProblem(
            422,
            "export-too-large",
            "This certificate is too large for PDF; export Excel instead",
          );
        const tenant = await scope.tx.tenant.findUnique({
          where: { id: scope.access.tenantId },
          select: { name: true },
        });
        await this.scope.audit(scope.tx, "valuation.exported", id, {
          projectId: row.projectId,
          format,
          status: row.status,
        });
        return {
          companyName: tenant?.name ?? "",
          clientName: project.project.clientName,
          valuation,
          generatedAt: new Date(),
        };
      },
      true,
    );
  }

  private fileName(data: CertificateExportData, extension: string) {
    const { valuation } = data;
    return `${valuation.project.code}-${valuation.certificateNumber ?? valuation.number}-${valuation.status}.${extension}`;
  }

  /** The summary rows shared by the PDF and Excel: label and signed amount (minor units). */
  private summary(data: CertificateExportData, locale: Locale) {
    const t = messages(locale).ipcExport;
    const { figures, terms } = data.valuation;
    const cap =
      figures.retentionCapMinor === null
        ? ""
        : fill(t.retentionCap, { amount: `KES ${formatMinor(figures.retentionCapMinor)}` });
    const rows: { label: string; amount: number; strong?: boolean }[] = [
      { label: t.workDone, amount: figures.workDoneMinor },
      { label: t.materialsGross, amount: figures.materialsGrossMinor },
      {
        label: fill(t.materials, { percent: terms.materialsPercent }),
        amount: figures.materialsMinor,
      },
      { label: t.gross, amount: figures.grossMinor, strong: true },
      {
        label:
          figures.retentionStage === "none"
            ? fill(t.retention, { percent: terms.retentionPercent, cap })
            : fill(t.retentionReleased, { stage: t.stages[figures.retentionStage] }),
        amount: -figures.retentionHeldMinor,
      },
      { label: t.adjustments, amount: figures.adjustmentsToDateMinor },
      { label: t.net, amount: figures.netToDateMinor, strong: true },
      { label: t.previous, amount: -figures.previousCertifiedMinor },
      { label: t.amountDue, amount: figures.amountDueMinor, strong: true },
      { label: fill(t.vat, { rate: terms.vatPercent }), amount: figures.vatMinor },
      { label: t.total, amount: figures.totalMinor, strong: true },
    ];
    return rows;
  }

  private title(data: CertificateExportData, locale: Locale) {
    const t = messages(locale).ipcExport;
    const { valuation } = data;
    if (valuation.status !== "certified") return t.valuationTitle;
    return valuation.kind === "retention_release" ? t.releaseTitle : t.title;
  }

  async xlsx(principal: Principal, id: string, locale: Locale, req: Request) {
    const data = await this.load(principal, id, "xlsx", req);
    const t = messages(locale).ipcExport;
    const { valuation } = data;
    const text = (value: string) => ({ t: "s", v: spreadsheetSafeText(value) });
    const money = (minor: number) => ({ t: "n", v: minor / 100, z: "#,##0.00" });
    const book = XLSX.utils.book_new();
    const head: unknown[][] = [
      [text(this.title(data, locale))],
      [text(t.company), text(data.companyName)],
      [text(t.project), text(`${valuation.project.code} – ${valuation.project.name}`)],
      ...(data.clientName ? [[text(t.client), text(data.clientName)]] : []),
      [
        text(
          valuation.certificateNumber
            ? fill(t.certificateLine, {
                certificate: valuation.certificateNumber,
                valuation: valuation.number,
              })
            : fill(t.valuationLine, {
                valuation: valuation.number,
                status: t.status[valuation.status],
              }),
        ),
      ],
      [text(t.valuationDate), text(day(valuation.valuationDate))],
      [text(fill(t.generated, { date: nairobiStamp.format(data.generatedAt) }))],
      [],
      ...(valuation.contractSum
        ? [
            [text(t.originalSum), money(valuation.contractSum.originalMinor)],
            [
              text(fill(t.revisedSum, { version: valuation.contractSum.revisedVersionNo })),
              money(valuation.contractSum.revisedMinor),
            ],
            [],
          ]
        : []),
      [text(t.summaryHeading)],
      ...this.summary(data, locale).map((row) => [text(row.label), money(row.amount)]),
      [],
      [text(t.netNote)],
      [
        text(
          fill(t.rule, {
            rule: valuation.terms.ruleVersion,
            version: valuation.terms.settingsVersion,
          }),
        ),
      ],
      [text(t.review)],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(head);
    sheet["!cols"] = [{ wch: 52 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(book, sheet, t.summarySheet);

    const lines: unknown[][] = [
      [text(t.itemsHeading)],
      [
        text(t.columns.ref),
        text(t.columns.description),
        text(t.columns.unit),
        text(t.columns.quantity),
        text(t.columns.rate),
        text(t.columns.previous),
        text(t.columns.thisPeriod),
        text(t.columns.toDate),
      ],
      ...valuation.lines.items.map((line) => [
        text(line.bqItem.ref ?? ""),
        text(
          line.overMeasured
            ? `${line.bqItem.description} (${t.overMeasured})`
            : line.bqItem.description,
        ),
        text(line.basis === "percent" ? "%" : (line.bqItem.unit ?? "")),
        line.quantityToDate === null ? null : { t: "n", v: Number(line.quantityToDate) },
        line.rate === null ? null : { t: "n", v: Number(line.rate), z: "#,##0.00##" },
        money(line.previousMinor),
        money(line.thisPeriodMinor),
        money(line.toDateMinor),
      ]),
      [],
      [text(t.materialsHeading)],
      [
        text(t.columns.source),
        text(t.columns.description),
        text(t.columns.unit),
        text(t.columns.quantity),
        null,
        null,
        null,
        text(t.columns.amount),
      ],
      ...valuation.lines.materials.map((line) => [
        text(t.sources[line.source]),
        text(line.description),
        text(line.unit ?? ""),
        { t: "n", v: Number(line.quantity) },
        null,
        null,
        null,
        money(line.amountMinor),
      ]),
      [],
      [text(t.adjustmentsHeading)],
      ...valuation.lines.adjustments.map((line) => [
        text(t.adjustmentKinds[line.kind]),
        text(line.description),
        null,
        null,
        null,
        null,
        null,
        money(line.amountMinor),
      ]),
    ];
    const lineSheet = XLSX.utils.aoa_to_sheet(lines);
    lineSheet["!cols"] = [
      { wch: 10 },
      { wch: 56 },
      { wch: 8 },
      { wch: 12 },
      { wch: 14 },
      { wch: 16 },
      { wch: 16 },
      { wch: 16 },
    ];
    XLSX.utils.book_append_sheet(book, lineSheet, t.linesSheet);
    book.Props = { Title: this.title(data, locale), Author: "PM-Buddy", Company: data.companyName };
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

  /** A4 PDF: header, contract sums, the certificate summary, lines, notes and signatures. */
  async pdf(principal: Principal, id: string, locale: Locale, req: Request) {
    return this.renderPdf(await this.load(principal, id, "pdf", req), locale);
  }

  /**
   * Renders the certificate PDF from data the caller already authorised (the staff export above,
   * or the client portal's certified-only download, D7.1).
   */
  async renderPdf(data: CertificateExportData, locale: Locale) {
    preparePdfmake();
    const t = messages(locale).ipcExport;
    const { valuation } = data;
    const right = (value: string, bold = false) => ({ text: value, alignment: "right", bold });
    const kes = (minor: number) => `KES ${formatMinor(minor)}`;
    const th = (value: string, alignment = "left") => ({ text: value, style: "th", alignment });
    const summaryBody = this.summary(data, locale).map((row) => [
      { text: row.label, bold: row.strong ?? false },
      right(kes(row.amount), row.strong ?? false),
    ]);
    const itemBody = [
      [
        th(t.columns.ref),
        th(t.columns.description),
        th(t.columns.quantity, "right"),
        th(t.columns.rate, "right"),
        th(t.columns.previous, "right"),
        th(t.columns.thisPeriod, "right"),
        th(t.columns.toDate, "right"),
      ],
      ...valuation.lines.items.map((line) => [
        line.bqItem.ref ?? "",
        {
          text: [
            line.bqItem.description,
            ...(line.overMeasured ? [{ text: ` (${t.overMeasured})`, italics: true }] : []),
          ],
        },
        right(
          line.quantityToDate === null
            ? "—"
            : `${formatDecimal(line.quantityToDate)} ${line.basis === "percent" ? "%" : (line.bqItem.unit ?? "")}`,
        ),
        right(line.rate === null ? "" : formatDecimal(line.rate)),
        right(formatMinor(line.previousMinor)),
        right(formatMinor(line.thisPeriodMinor)),
        right(formatMinor(line.toDateMinor)),
      ]),
    ];
    const materialsBody = [
      [
        th(t.columns.source),
        th(t.columns.description),
        th(t.columns.quantity, "right"),
        th(t.columns.amount, "right"),
      ],
      ...valuation.lines.materials.map((line) => [
        t.sources[line.source],
        line.description,
        right(`${formatDecimal(line.quantity)} ${line.unit ?? ""}`),
        right(formatMinor(line.amountMinor)),
      ]),
    ];
    const adjustmentsBody = [
      [th(t.columns.kind), th(t.columns.description), th(t.columns.amount, "right")],
      ...valuation.lines.adjustments.map((line) => [
        t.adjustmentKinds[line.kind],
        line.description,
        right(formatMinor(line.amountMinor)),
      ]),
    ];
    const signature = (role: string, name: string | null, when: string | null) => ({
      stack: [
        { text: role, bold: true, fontSize: 8 },
        { text: name ?? " ", margin: [0, 4, 0, 0] },
        { text: when ?? " ", fontSize: 7.5, color: "#555555" },
        {
          canvas: [{ type: "line", x1: 0, y1: 18, x2: 150, y2: 18, lineWidth: 0.6 }],
        },
        { text: t.nameDate, fontSize: 7, color: "#555555", margin: [0, 2, 0, 0] },
      ],
    });
    const definition = {
      pageSize: "A4",
      pageMargins: [36, 56, 36, 48],
      info: {
        title: `${this.title(data, locale)} – ${valuation.project.code}`,
        author: data.companyName,
        creator: "PM-Buddy",
      },
      defaultStyle: { font: "Roboto", fontSize: 8.5 },
      ...(valuation.status === "certified"
        ? {}
        : { watermark: { text: t.watermark, color: "#b91c1c", opacity: 0.1, bold: true } }),
      header: () => ({
        margin: [36, 22, 36, 0],
        columns: [
          { text: data.companyName, bold: true, fontSize: 8 },
          {
            text: `${valuation.project.code} · ${valuation.project.name}`,
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
        { text: this.title(data, locale), style: "h1" },
        {
          text: valuation.certificateNumber
            ? fill(t.certificateLine, {
                certificate: valuation.certificateNumber,
                valuation: valuation.number,
              })
            : fill(t.valuationLine, {
                valuation: valuation.number,
                status: t.status[valuation.status],
              }),
          bold: true,
        },
        {
          columns: [
            {
              stack: [
                { text: `${t.project}: ${valuation.project.code} – ${valuation.project.name}` },
                ...(data.clientName ? [{ text: `${t.client}: ${data.clientName}` }] : []),
                { text: `${t.company}: ${data.companyName}` },
              ],
            },
            {
              text: `${t.valuationDate}: ${day(valuation.valuationDate)}`,
              alignment: "right",
            },
          ],
          margin: [0, 6, 0, 0],
        },
        ...(valuation.contractSum
          ? [
              { text: t.contractSum, style: "h2" },
              {
                table: {
                  widths: ["*", 120],
                  body: [
                    [t.originalSum, right(kes(valuation.contractSum.originalMinor))],
                    [
                      fill(t.revisedSum, { version: valuation.contractSum.revisedVersionNo }),
                      right(kes(valuation.contractSum.revisedMinor)),
                    ],
                  ],
                },
                layout: "lightHorizontalLines",
              },
            ]
          : []),
        { text: t.summaryHeading, style: "h2" },
        { table: { widths: ["*", 120], body: summaryBody }, layout: "lightHorizontalLines" },
        { text: t.netNote, italics: true, color: "#555555", margin: [0, 6, 0, 0] },
        {
          text: fill(t.rule, {
            rule: valuation.terms.ruleVersion,
            version: valuation.terms.settingsVersion,
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
              valuation.submittedBy?.displayName ?? valuation.createdBy.displayName,
              valuation.submittedAt ? nairobiStamp.format(new Date(valuation.submittedAt)) : null,
            ),
            signature(
              t.certifiedBy,
              valuation.certifiedBy?.displayName ?? null,
              valuation.certifiedAt ? nairobiStamp.format(new Date(valuation.certifiedAt)) : null,
            ),
            signature(t.receivedBy, null, null),
          ],
          columnGap: 14,
        },
        ...(valuation.lines.items.length
          ? [
              { text: t.itemsHeading, style: "h2", pageBreak: "before" },
              {
                table: {
                  headerRows: 1,
                  dontBreakRows: true,
                  widths: [28, "*", 58, 50, 60, 60, 62],
                  body: itemBody,
                },
                layout: "lightHorizontalLines",
              },
            ]
          : []),
        ...(valuation.lines.materials.length
          ? [
              { text: t.materialsHeading, style: "h2" },
              {
                table: { headerRows: 1, widths: [70, "*", 80, 80], body: materialsBody },
                layout: "lightHorizontalLines",
              },
            ]
          : []),
        ...(valuation.lines.adjustments.length
          ? [
              { text: t.adjustmentsHeading, style: "h2" },
              {
                table: { headerRows: 1, widths: [90, "*", 90], body: adjustmentsBody },
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
      disposition: contentDisposition(this.fileName(data, "pdf")),
    };
  }
}
