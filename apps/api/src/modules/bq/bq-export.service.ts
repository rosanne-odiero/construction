import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import pdfmake from "pdfmake";
import * as XLSX from "xlsx";
import {
  BQ_UNIT_LABELS,
  contentDisposition,
  spreadsheetSafeText,
  type BqKindTotals,
} from "@pm-buddy/domain";
import { messages, type Locale } from "@pm-buddy/i18n";
import type { BqItemKind, BqUnit } from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { BqAccess, bqProblem } from "./bq-access.js";
import { safeMinor } from "./bq-mappers.js";
import { currentVersion } from "./bq-viewer.service.js";

type ItemRow = Prisma.BqItemGetPayload<object>;
/** A pdfmake table cell: plain text or a styled cell object. */
type PdfCell = string | Record<string, unknown>;
type SectionRow = Prisma.BqSectionGetPayload<object>;
type BillRow = Prisma.BqBillGetPayload<object>;

/** PDFs above this many items are refused (Excel has no such limit); the renderer is in-process. */
export const PDF_MAX_ITEMS = 10_000;

const KIND_BUCKET: Record<BqItemKind, keyof BqKindTotals> = {
  measured: "measured",
  preliminary: "preliminaries",
  provisional_sum: "provisionalSums",
  pc_sum: "pcSums",
  pc_attendance: "pcAttendanceProfit",
  pc_profit: "pcAttendanceProfit",
  contingency: "contingencies",
  daywork: "dayworks",
};

const grouping = new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 });
const nairobiDate = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Africa/Nairobi",
});

/** Minor units → "1,250,000.00", exactly (no floating point). */
export function formatMinor(minor: number): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = grouping.format(absolute / 100n);
  const cents = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "−" : ""}${whole}.${cents}`;
}

/** A decimal string with thousands separators ("12345.5" → "12,345.5"). */
export function formatDecimal(value: string | null): string {
  if (value === null) return "";
  const [whole = "0", fraction] = value.replace(/^-/, "").split(".");
  const grouped = grouping.format(BigInt(whole));
  return `${value.startsWith("-") ? "−" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

const unitLabel = (item: ItemRow) =>
  item.unit && item.unit !== "other"
    ? BQ_UNIT_LABELS[item.unit as Exclude<BqUnit, "other">]
    : (item.unitRaw ?? "");

/** Loads Roboto into pdfmake's virtual file system and denies every URL and local file access. */
let pdfmakeReady = false;
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
  // Templates are ours and never reference external resources; user text is only ever text.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);
  pdfmakeReady = true;
}

type ExportData = {
  companyName: string;
  project: { code: string; name: string };
  version: Prisma.BqVersionGetPayload<object>;
  bills: { bill: BillRow; sections: { section: SectionRow; items: ItemRow[] }[] }[];
  byKind: BqKindTotals;
  sourceFileName: string | null;
  generatedAt: Date;
};

/** Excel and PDF exports of the current BQ version (bq.view). */
@Injectable()
export class BqExportService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: BqAccess,
    private readonly security: AuthSecurity,
  ) {}

  private async load(
    principal: Principal,
    projectId: string,
    format: "xlsx" | "pdf",
    req: Request,
  ): Promise<ExportData> {
    await this.security.limit(`bq-export:${principal.user.id}`, 60, 600);
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { project } = await this.access.load(scope, projectId, "bq.view");
        const { tx, access } = scope;
        const current = await currentVersion(tx, access.tenantId, projectId);
        if (!current)
          throw new NotFoundException({
            message: "This project has no BQ yet",
            code: "bq-not-found",
          });
        const { version } = current;
        if (format === "pdf" && version.itemCount > PDF_MAX_ITEMS)
          throw bqProblem(
            422,
            "export-too-large",
            "This BQ is too large for PDF; export Excel instead",
          );
        const where = { tenantId: access.tenantId, versionId: version.id };
        const [tenant, bills, sections, items, source] = await Promise.all([
          tx.tenant.findUnique({ where: { id: access.tenantId }, select: { name: true } }),
          tx.bqBill.findMany({ where, orderBy: { sortOrder: "asc" } }),
          tx.bqSection.findMany({ where, orderBy: { sortOrder: "asc" } }),
          tx.bqItem.findMany({ where, orderBy: [{ billId: "asc" }, { sortOrder: "asc" }] }),
          tx.bqImport.findFirst({
            where: { tenantId: access.tenantId, bqVersionId: version.id, status: "committed" },
            select: { fileName: true },
          }),
        ]);
        const byKind: BqKindTotals = {
          measured: 0,
          preliminaries: 0,
          provisionalSums: 0,
          pcSums: 0,
          pcAttendanceProfit: 0,
          contingencies: 0,
          dayworks: 0,
        };
        for (const item of items)
          byKind[KIND_BUCKET[item.kind as BqItemKind]] += safeMinor(item.amountMinor);
        await this.scope.audit(tx, "bq.exported", version.id, {
          projectId,
          format,
          versionNo: version.versionNo,
        });
        return {
          companyName: tenant?.name ?? "",
          project: { code: project.code, name: project.name },
          version,
          bills: bills.map((bill) => ({
            bill,
            sections: sections
              .filter((section) => section.billId === bill.id)
              .map((section) => ({
                section,
                items: items.filter((item) => item.sectionId === section.id),
              })),
          })),
          byKind,
          sourceFileName: source?.fileName ?? null,
          generatedAt: new Date(),
        };
      },
      true,
    );
  }

  private fileName(data: ExportData, extension: string) {
    return `${data.project.code}-BQ-v${data.version.versionNo}-${data.version.status}.${extension}`;
  }

  /**
   * Excel: a summary sheet and one sheet per bill with section headings, subtotals and the bill
   * total. Every text cell is neutralised against formula injection; amounts and quantities stay
   * numeric (KES with two decimals).
   */
  async xlsx(principal: Principal, projectId: string, locale: Locale, req: Request) {
    const data = await this.load(principal, projectId, "xlsx", req);
    const t = messages(locale).bqExport;
    const text = (value: string) => ({ t: "s", v: spreadsheetSafeText(value) });
    const money = (minor: number) => ({ t: "n", v: minor / 100, z: "#,##0.00" });
    const decimal = (value: Prisma.Decimal | null) =>
      value === null ? null : { t: "n", v: value.toNumber(), z: "#,##0.####" };
    const book = XLSX.utils.book_new();
    const status = t.status[data.version.status as keyof typeof t.status] ?? data.version.status;
    const vatRate = data.version.vatRatePercent.toFixed();

    const summary: unknown[][] = [
      [text(t.title)],
      [text(t.company), text(data.companyName)],
      [text(t.project), text(`${data.project.code} – ${data.project.name}`)],
      [text(fill(t.versionLine, { version: data.version.versionNo, status }))],
      [text(fill(t.generated, { date: nairobiDate.format(data.generatedAt) }))],
      ...(data.sourceFileName ? [[text(fill(t.sourceLine, { file: data.sourceFileName }))]] : []),
      [],
      [text(t.billsHeading)],
      [text(t.columns.ref), text(t.columns.description), text(t.columns.amount)],
      ...data.bills.map(({ bill }) => [
        text(fill(t.billSheet, { number: bill.number })),
        text(bill.title),
        money(safeMinor(bill.totalMinor)),
      ]),
      [],
      [text(t.subtotal), null, money(safeMinor(data.version.subtotalMinor))],
      [text(fill(t.vat, { rate: vatRate })), null, money(safeMinor(data.version.vatMinor))],
      [text(t.grandTotal), null, money(safeMinor(data.version.grandTotalMinor))],
      [],
      [text(t.breakdownHeading)],
      ...(Object.keys(data.byKind) as (keyof BqKindTotals)[])
        .filter((kind) => data.byKind[kind] !== 0)
        .map((kind) => [text(t.kinds[kind]), null, money(data.byKind[kind])]),
      [],
      [text(t.vatReview)],
    ];
    const summarySheet = XLSX.utils.aoa_to_sheet(summary);
    summarySheet["!cols"] = [{ wch: 28 }, { wch: 60 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(book, summarySheet, this.sheetName(t.summarySheet, new Set()));

    const used = new Set([t.summarySheet]);
    for (const { bill, sections } of data.bills) {
      const rows: unknown[][] = [
        [text(fill(t.billHeading, { number: bill.number, title: bill.title }))],
        [],
        [
          text(t.columns.ref),
          text(t.columns.description),
          text(t.columns.unit),
          text(t.columns.quantity),
          text(t.columns.rate),
          text(t.columns.amount),
          text(t.columns.notes),
        ],
      ];
      for (const { section, items } of sections) {
        if (section.title || section.code)
          rows.push([text(section.code ?? ""), text(section.title ?? "")]);
        if (section.notes) rows.push([null, text(section.notes)]);
        for (const item of items)
          rows.push([
            text(item.ref ?? ""),
            text(item.description),
            text(unitLabel(item)),
            decimal(item.quantity),
            decimal(item.rate),
            money(safeMinor(item.amountMinor)),
            text(item.notes ?? ""),
          ]);
        rows.push([
          null,
          text(t.sectionTotal),
          null,
          null,
          null,
          money(safeMinor(section.totalMinor)),
        ]);
        rows.push([]);
      }
      rows.push([
        null,
        text(fill(t.billTotal, { number: bill.number })),
        null,
        null,
        null,
        money(safeMinor(bill.totalMinor)),
      ]);
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      sheet["!cols"] = [
        { wch: 8 },
        { wch: 60 },
        { wch: 8 },
        { wch: 12 },
        { wch: 14 },
        { wch: 18 },
        { wch: 24 },
      ];
      const name = this.sheetName(fill(t.billSheet, { number: bill.number }), used);
      used.add(name);
      XLSX.utils.book_append_sheet(book, sheet, name);
    }
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

  /** Excel sheet names: at most 31 characters, none of []:*?/\, unique, not starting with '. */
  private sheetName(base: string, used: ReadonlySet<string>): string {
    const cleaned =
      base
        .replace(/[[\]:*?/\\]/g, "-")
        .replace(/^'+|'+$/g, "")
        .slice(0, 28) || "Bill";
    let name = cleaned;
    for (let counter = 2; used.has(name); counter += 1)
      name = `${cleaned.slice(0, 25)} (${counter})`;
    return name;
  }

  /**
   * PDF (pdfmake, A4): company and project header, KES amounts, page numbers and a draft
   * watermark while the version is a draft. Rendered from our own template; no URL or file access.
   */
  async pdf(principal: Principal, projectId: string, locale: Locale, req: Request) {
    const data = await this.load(principal, projectId, "pdf", req);
    preparePdfmake();
    const t = messages(locale).bqExport;
    const status = t.status[data.version.status as keyof typeof t.status] ?? data.version.status;
    const vatRate = data.version.vatRatePercent.toFixed();
    const generated = fill(t.generated, { date: nairobiDate.format(data.generatedAt) });
    const right = (value: string, bold = false) => ({ text: value, alignment: "right", bold });
    const kes = (minor: number) => `KES ${formatMinor(minor)}`;

    const summaryBody: PdfCell[][] = [
      [
        { text: t.columns.ref, style: "th" },
        { text: t.columns.description, style: "th" },
        { text: t.columns.amount, style: "th", alignment: "right" },
      ],
      ...data.bills.map(({ bill }) => [
        fill(t.billSheet, { number: bill.number }),
        bill.title,
        right(formatMinor(safeMinor(bill.totalMinor))),
      ]),
      [
        { text: t.subtotal, colSpan: 2, bold: true },
        {},
        right(kes(safeMinor(data.version.subtotalMinor)), true),
      ],
      [
        { text: fill(t.vat, { rate: vatRate }), colSpan: 2 },
        {},
        right(kes(safeMinor(data.version.vatMinor))),
      ],
      [
        { text: t.grandTotal, colSpan: 2, bold: true },
        {},
        right(kes(safeMinor(data.version.grandTotalMinor)), true),
      ],
    ];
    const breakdownBody: PdfCell[][] = (Object.keys(data.byKind) as (keyof BqKindTotals)[])
      .filter((kind) => data.byKind[kind] !== 0)
      .map((kind) => [t.kinds[kind], right(formatMinor(data.byKind[kind]))]);

    const billBlocks = data.bills.flatMap(({ bill, sections }) => {
      const body: PdfCell[][] = [
        [
          { text: t.columns.ref, style: "th" },
          { text: t.columns.description, style: "th" },
          { text: t.columns.unit, style: "th" },
          { text: t.columns.quantity, style: "th", alignment: "right" },
          { text: t.columns.rate, style: "th", alignment: "right" },
          { text: t.columns.amount, style: "th", alignment: "right" },
        ],
      ];
      for (const { section, items } of sections) {
        if (section.title || section.code)
          body.push([
            { text: section.code ?? "", bold: true },
            { text: section.title ?? "", bold: true, colSpan: 5 },
            {},
            {},
            {},
            {},
          ]);
        for (const item of items)
          body.push([
            item.ref ?? "",
            item.description,
            unitLabel(item),
            right(formatDecimal(item.quantity?.toFixed() ?? null)),
            right(item.rate === null ? "" : formatDecimal(item.rate.toFixed())),
            right(formatMinor(safeMinor(item.amountMinor))),
          ]);
        body.push([
          "",
          { text: t.sectionTotal, italics: true, colSpan: 4 },
          {},
          {},
          {},
          right(formatMinor(safeMinor(section.totalMinor))),
        ]);
      }
      body.push([
        "",
        { text: fill(t.billTotal, { number: bill.number }), bold: true, colSpan: 4 },
        {},
        {},
        {},
        right(kes(safeMinor(bill.totalMinor)), true),
      ]);
      return [
        {
          text: fill(t.billHeading, { number: bill.number, title: bill.title }),
          style: "h2",
          pageBreak: "before",
        },
        {
          table: { headerRows: 1, dontBreakRows: true, widths: [28, "*", 34, 50, 58, 72], body },
          layout: "lightHorizontalLines",
        },
      ];
    });

    const definition = {
      pageSize: "A4",
      pageMargins: [36, 56, 36, 48],
      info: {
        title: `${t.title} – ${data.project.code}`,
        author: data.companyName,
        creator: "PM-Buddy",
      },
      defaultStyle: { font: "Roboto", fontSize: 8.5 },
      ...(data.version.status === "draft"
        ? { watermark: { text: t.watermark, color: "#b91c1c", opacity: 0.1, bold: true } }
        : {}),
      header: () => ({
        margin: [36, 22, 36, 0],
        columns: [
          { text: data.companyName, bold: true, fontSize: 8 },
          { text: `${data.project.code} · ${data.project.name}`, alignment: "right", fontSize: 8 },
        ],
      }),
      footer: (currentPage: number, pageCount: number) => ({
        margin: [36, 14, 36, 0],
        columns: [
          { text: generated, fontSize: 7, color: "#555555" },
          {
            text: fill(t.page, { page: currentPage, pages: pageCount }),
            alignment: "right",
            fontSize: 7,
          },
        ],
      }),
      content: [
        { text: t.title, style: "h1" },
        { text: `${data.project.code} – ${data.project.name}`, margin: [0, 0, 0, 2] },
        {
          text: fill(t.versionLine, { version: data.version.versionNo, status }),
          margin: [0, 0, 0, 2],
        },
        ...(data.sourceFileName
          ? [{ text: fill(t.sourceLine, { file: data.sourceFileName }), color: "#555555" }]
          : []),
        { text: t.billsHeading, style: "h2" },
        {
          table: { headerRows: 1, widths: [50, "*", 110], body: summaryBody },
          layout: "lightHorizontalLines",
        },
        ...(breakdownBody.length
          ? [
              { text: t.breakdownHeading, style: "h3" },
              { table: { widths: ["*", 110], body: breakdownBody }, layout: "noBorders" },
            ]
          : []),
        { text: t.vatReview, italics: true, color: "#555555", margin: [0, 10, 0, 0] },
        ...billBlocks,
      ],
      styles: {
        h1: { fontSize: 16, bold: true, margin: [0, 0, 0, 6] },
        h2: { fontSize: 11.5, bold: true, margin: [0, 12, 0, 6] },
        h3: { fontSize: 9.5, bold: true, margin: [0, 10, 0, 4] },
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
