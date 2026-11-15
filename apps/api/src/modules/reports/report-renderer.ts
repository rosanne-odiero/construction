import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import pdfmake from "pdfmake";
import * as XLSX from "xlsx";
import {
  excelSerialDate,
  excelSerialNairobi,
  minorToShillings,
  spreadsheetSafeText,
} from "@pm-buddy/domain";
import { messages } from "@pm-buddy/i18n";
import { REPORT_LIMITS } from "@pm-buddy/types";
import type { ReportCell, ReportColumn, ReportModel } from "@pm-buddy/validation";
import { formatDecimal, formatMinor } from "../bq/bq-export.service.js";
import { fill } from "./report-model.js";
import { reportProblem } from "./reports-access.js";

const nairobiStamp = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Africa/Nairobi",
});
/** DD/MM/YYYY for a business date. */
export const day = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
export const stamp = (iso: string) => nairobiStamp.format(new Date(iso)).replace(",", "");

/** One cell as text for the PDF (and plain-text checks): KES amounts, DD/MM/YYYY, Nairobi time. */
export function cellText(type: ReportColumn["type"], cell: ReportCell): string {
  if (cell === null) return "—";
  if (type === "money") return formatMinor(cell as number);
  const text = String(cell);
  if (type === "date") return day(text);
  if (type === "datetime") return stamp(text);
  if (type === "quantity") return formatDecimal(text);
  if (type === "percent") return `${text} %`;
  return text;
}

const numeric = (type: ReportColumn["type"]) =>
  type === "money" || type === "quantity" || type === "percent";

export const totalRows = (model: ReportModel) =>
  model.sections.reduce((total, section) => total + section.rowCount, 0);

/** 422 use-excel above the PDF row limit (D-122). */
export function assertPdfFits(model: ReportModel) {
  if (totalRows(model) > REPORT_LIMITS.pdfMaxRows)
    throw reportProblem(
      422,
      "use-excel",
      `This report has more than ${REPORT_LIMITS.pdfMaxRows.toLocaleString("en")} rows; download Excel or narrow it`,
    );
}

export function reportFileName(model: ReportModel, extension: "pdf" | "xlsx") {
  const query = model.query;
  const scope = model.parameters.find((parameter) => parameter.key === "project")?.value ?? "";
  const code = /^[A-Z0-9-]+/.exec(scope)?.[0];
  const period =
    query.from && query.to ? `-${query.from}-${query.to}` : query.asAt ? `-${query.asAt}` : "";
  return `${model.report.id}${code ? `-${code}` : ""}${period}.${extension}`;
}

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
 * The one report renderer for files (D-122): any report model as an A4 PDF (landscape when wide;
 * header with company and title, parameters, generated at in Nairobi time and by whom, page
 * numbers; money as KES with thousands separators) — at most REPORT_LIMITS.pdfMaxRows rows, else
 * 422 use-excel. Generated on demand, never stored.
 */
export async function renderPdf(model: ReportModel): Promise<Buffer> {
  assertPdfFits(model);
  preparePdfmake();
  const t = messages(model.locale).reportExport;
  const widest = Math.max(...model.sections.map((section) => section.columns.length));
  const landscape = widest > 7;
  const fontSize = widest > 20 ? 5.5 : widest > 10 ? 7 : 8.5;
  const generated = fill(t.generated, {
    date: stamp(model.generatedAt),
    name: model.generatedBy.displayName,
  });
  const th = (column: ReportColumn) => ({
    text: column.label,
    style: "th",
    alignment: numeric(column.type) ? "right" : "left",
  });
  const td = (column: ReportColumn, cell: ReportCell, bold = false) => ({
    text: cellText(column.type, cell),
    alignment: numeric(column.type) ? "right" : "left",
    bold,
  });
  const sections = model.sections.flatMap((section) => {
    const widths = section.columns.map((column) =>
      section.columns.length > 20
        ? column.key.startsWith("d-")
          ? 15
          : "*"
        : column.type === "text"
          ? "*"
          : "auto",
    );
    const body = [
      section.columns.map(th),
      ...section.rows.map((row) =>
        section.columns.map((column, index) => td(column, row[index] ?? null)),
      ),
      ...(section.totals
        ? [
            section.columns.map((column, index) =>
              index === 0
                ? { text: String(section.totals![0] ?? ""), bold: true }
                : td(column, section.totals![index] ?? null, true),
            ),
          ]
        : []),
    ];
    return [
      { text: section.title, style: "h2" },
      section.rows.length
        ? { table: { headerRows: 1, widths, body }, layout: "lightHorizontalLines" }
        : { text: t.empty, italics: true },
      ...section.notes.map((note) => ({ text: note, style: "note" })),
    ];
  });
  const definition = {
    pageSize: "A4",
    pageOrientation: landscape ? "landscape" : "portrait",
    pageMargins: [30, 50, 30, 44],
    info: { title: model.report.title, author: model.company.name, creator: "PM-Buddy" },
    defaultStyle: { font: "Roboto", fontSize },
    header: () => ({
      margin: [30, 20, 30, 0],
      columns: [
        { text: model.company.name, bold: true, fontSize: 8 },
        { text: model.report.title, alignment: "right", fontSize: 8 },
      ],
    }),
    footer: (currentPage: number, pageCount: number) => ({
      margin: [30, 12, 30, 0],
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
      { text: model.report.title, style: "h1" },
      ...model.parameters.map((parameter) => ({
        text: [{ text: `${parameter.label}: `, bold: true }, parameter.value],
        fontSize: 8.5,
      })),
      { text: `${generated} · ${t.currency}`, fontSize: 8, color: "#555555", margin: [0, 2, 0, 4] },
      ...sections,
      ...model.notes.map((note) => ({ text: note, style: "note" })),
    ],
    styles: {
      h1: { fontSize: 15, bold: true, margin: [0, 0, 0, 6] },
      h2: { fontSize: 11, bold: true, margin: [0, 12, 0, 5] },
      th: { bold: true, fillColor: "#eef2ff" },
      note: { fontSize: 7.5, color: "#555555", margin: [0, 6, 0, 0] },
    },
  };
  return pdfmake.createPdf(definition).getBuffer();
}

type SheetCell = { t: "s" | "n"; v: string | number; z?: string } | null;

/** A typed spreadsheet cell; text is always neutralised against formula injection (brief §15 F). */
export function excelCell(type: ReportColumn["type"], cell: ReportCell): SheetCell {
  if (cell === null) return null;
  if (type === "money") return { t: "n", v: minorToShillings(cell as number), z: "#,##0.00" };
  const text = String(cell);
  if (type === "date") return { t: "n", v: excelSerialDate(text), z: "dd/mm/yyyy" };
  if (type === "datetime")
    return { t: "n", v: excelSerialNairobi(new Date(text)), z: "dd/mm/yyyy hh:mm" };
  if (type === "quantity") return { t: "n", v: Number(text) };
  if (type === "percent") return { t: "n", v: Number(text) / 100, z: "0.0%" };
  return { t: "s", v: spreadsheetSafeText(text) };
}

const sheetName = (title: string, used: Set<string>) => {
  const base =
    title
      .replace(/[[\]:*?/\\]/g, " ")
      .slice(0, 28)
      .trim() || "Sheet";
  let name = base;
  for (let n = 2; used.has(name); n += 1) name = `${base} ${n}`;
  used.add(name);
  return name;
};

/**
 * The same model as Excel (D-122): one sheet per section with the common header; money as numbers
 * of shillings with two decimals, dates and times as real Excel dates (Nairobi wall-clock), every
 * text cell neutralised against formula injection. At most REPORT_LIMITS.maxRows rows (the model
 * already refused more).
 */
export function renderXlsx(model: ReportModel): Buffer {
  const t = messages(model.locale).reportExport;
  const text = (value: string) => ({ t: "s", v: spreadsheetSafeText(value) });
  const generated = fill(t.generated, {
    date: stamp(model.generatedAt),
    name: model.generatedBy.displayName,
  });
  const book = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const section of model.sections) {
    const rows: unknown[][] = [
      [text(model.report.title)],
      [text(model.company.name)],
      ...model.parameters.map((parameter) => [text(`${parameter.label}: ${parameter.value}`)]),
      [text(generated)],
      [text(t.excelMoney)],
      [],
      [text(section.title)],
      section.columns.map((column) => text(column.label)),
      ...section.rows.map((row) =>
        section.columns.map((column, index) => excelCell(column.type, row[index] ?? null)),
      ),
      ...(section.totals
        ? [
            section.columns.map((column, index) =>
              index === 0
                ? text(String(section.totals![0] ?? ""))
                : excelCell(column.type, section.totals![index] ?? null),
            ),
          ]
        : []),
      ...(section.rows.length ? [] : [[text(t.empty)]]),
      [],
      ...[...section.notes, ...model.notes].map((note) => [text(note)]),
    ];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = section.columns.map((column) => ({
      wch:
        column.type === "text"
          ? column.key.startsWith("d-")
            ? 6
            : 28
          : column.type === "datetime"
            ? 17
            : column.type === "date"
              ? 12
              : 15,
    }));
    XLSX.utils.book_append_sheet(book, sheet, sheetName(section.title, used));
  }
  book.Props = { Title: model.report.title, Author: "PM-Buddy", Company: model.company.name };
  return XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
