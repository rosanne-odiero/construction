"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronUp, FunctionSquare, Save, Trash2, Wand2 } from "lucide-react";
import { BQ_FIELDS, type BqField } from "@pm-buddy/types";
import {
  bqImportResponseSchema,
  bqSheetRowsResponseSchema,
  bqTemplateResponseSchema,
  bqTemplatesResponseSchema,
  messageResponseSchema,
  type BqImport,
  type BqMappingInput,
  type BqSheetRowsResponse,
  type BqTemplate,
} from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { cn } from "@/lib/utils";
import { useProblemMessage } from "@/components/projects/use-problem-message";

export const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none disabled:opacity-50";
const WINDOW = 25;

type Notify = (message: { error: boolean; text: string }) => void;

/**
 * Step 3: which column holds each field, with the sheet's raw rows (header highlighted, formula
 * cells marked) and the company's saved mapping templates.
 */
export function ColumnsStep({
  projectId,
  current,
  draft,
  setDraft,
  onImport,
  notify,
}: {
  projectId: string;
  current: BqImport;
  draft: BqMappingInput;
  setDraft: (mapping: BqMappingInput) => void;
  onImport: (next: BqImport) => void;
  notify: Notify;
}) {
  const t = useTranslations("bqWizard.columns");
  const problem = useProblemMessage();
  const billSheets = draft.sheets.filter((sheet) => sheet.include && sheet.role === "bill");
  const [sheetIndex, setSheetIndex] = useState(billSheets[0]?.sheetIndex ?? 0);
  const mapping = draft.sheets.find((sheet) => sheet.sheetIndex === sheetIndex);
  const summary = current.sheets?.[sheetIndex];
  const [from, setFrom] = useState(Math.max(1, (mapping?.headerRow ?? 1) - 2));
  const [rowsWindow, setRowsWindow] = useState<BqSheetRowsResponse | null>(null);
  const [rowsError, setRowsError] = useState<unknown>(null);
  const [headerTitles, setHeaderTitles] = useState<(string | null)[]>([]);
  const [templates, setTemplates] = useState<BqTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    liveRequest(
      `/projects/${projectId}/bq/imports/${current.id}/sheets/${sheetIndex}/rows?from=${from}&count=${WINDOW}`,
      bqSheetRowsResponseSchema,
    )
      .then((data) => {
        if (cancelled) return;
        setRowsWindow(data);
        setRowsError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setRowsError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, current.id, sheetIndex, from]);

  const headerRow = mapping?.headerRow ?? 1;
  useEffect(() => {
    let cancelled = false;
    liveRequest(
      `/projects/${projectId}/bq/imports/${current.id}/sheets/${sheetIndex}/rows?from=${headerRow}&count=1`,
      bqSheetRowsResponseSchema,
    )
      .then((data) => {
        if (!cancelled) setHeaderTitles(data.rows[0]?.cells ?? []);
      })
      .catch(() => {
        if (!cancelled) setHeaderTitles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, current.id, sheetIndex, headerRow]);

  useEffect(() => {
    liveRequest(`/projects/${projectId}/bq/templates`, bqTemplatesResponseSchema)
      .then((data) => setTemplates(data.templates))
      .catch(() => setTemplates([]));
  }, [projectId]);

  if (!mapping || !summary) return <p>{t("noBills")}</p>;
  const width = Math.max(summary.usedColumns, 1);
  const columnLabel = (index: number) => {
    const letter = rowsWindow?.columns[index]?.letter ?? String.fromCharCode(65 + (index % 26));
    const title = headerTitles[index];
    return title ? t("column", { letter, title }) : t("columnNoTitle", { letter });
  };
  const fieldOf = (column: number) =>
    (Object.entries(mapping.columns) as [BqField, number | undefined][]).find(
      ([, value]) => value === column,
    )?.[0];

  function setColumn(field: BqField, value: string) {
    const columns = { ...mapping!.columns };
    if (value === "") delete columns[field];
    else columns[field] = Number(value);
    setDraft({
      ...draft,
      sheets: draft.sheets.map((sheet) =>
        sheet.sheetIndex === sheetIndex ? { ...sheet, columns } : sheet,
      ),
    });
  }

  async function run<T>(operation: () => Promise<T>, success: (result: T) => string) {
    setBusy(true);
    try {
      const result = await operation();
      notify({ error: false, text: success(result) });
      return result;
    } catch (error) {
      notify({ error: true, text: problem(error) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function applyTemplate() {
    const result = await run(
      () =>
        liveRequest(
          `/projects/${projectId}/bq/imports/${current.id}/apply-template`,
          bqImportResponseSchema,
          { method: "POST", body: { templateId, version: current.version } },
        ),
      (response) =>
        t("applied", {
          count:
            response.import.mapping?.sheets.filter(
              (sheet) => sheet.include && sheet.role === "bill",
            ).length ?? 0,
        }),
    );
    if (result) onImport(result.import);
  }

  async function saveTemplate() {
    const result = await run(
      () =>
        liveRequest(`/projects/${projectId}/bq/templates`, bqTemplateResponseSchema, {
          method: "POST",
          body: { name: templateName.trim(), importId: current.id, sheetIndex },
        }),
      (response) => t("templateSaved", { name: response.template.name }),
    );
    if (result) {
      setTemplates((list) => [...(list ?? []), result.template]);
      setTemplateName("");
    }
  }

  async function deleteTemplate(template: BqTemplate) {
    const result = await run(
      () =>
        liveRequest(`/projects/${projectId}/bq/templates/${template.id}`, messageResponseSchema, {
          method: "DELETE",
        }),
      () => t("templateDeleted"),
    );
    if (result) setTemplates((list) => (list ?? []).filter((entry) => entry.id !== template.id));
  }

  const savedMapping = current.status === "mapped" || current.status === "validated";

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-[minmax(0,16rem)_1fr]">
        <div className="space-y-1.5">
          <label htmlFor="columns-sheet" className="text-sm font-medium">
            {t("sheet")}
          </label>
          <select
            id="columns-sheet"
            className={selectClass}
            value={sheetIndex}
            onChange={(event) => {
              const index = Number(event.target.value);
              setSheetIndex(index);
              const next = draft.sheets.find((sheet) => sheet.sheetIndex === index);
              setFrom(Math.max(1, (next?.headerRow ?? 1) - 2));
            }}
          >
            {billSheets.map((sheet) => (
              <option key={sheet.sheetIndex} value={sheet.sheetIndex}>
                {current.sheets?.[sheet.sheetIndex]?.name ?? sheet.sheetIndex}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <legend className="sr-only">{t("legend")}</legend>
          {BQ_FIELDS.map((field) => (
            <div key={field} className="space-y-1.5">
              <label htmlFor={`column-${field}`} className="text-sm font-medium">
                {t(`fields.${field}`)}
              </label>
              <select
                id={`column-${field}`}
                className={selectClass}
                value={mapping.columns[field] ?? ""}
                onChange={(event) => setColumn(field, event.target.value)}
              >
                <option value="">{t("none")}</option>
                {Array.from({ length: width }, (_, index) => (
                  <option key={index} value={index}>
                    {columnLabel(index)}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </fieldset>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {rowsWindow
              ? t("preview", {
                  from: rowsWindow.from,
                  to: rowsWindow.from + Math.max(rowsWindow.rows.length - 1, 0),
                  total: rowsWindow.totalRows,
                })
              : null}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={from <= 1}
              onClick={() => setFrom(Math.max(1, from - WINDOW))}
            >
              <ChevronUp aria-hidden /> {t("previous")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!rowsWindow || from + WINDOW > rowsWindow.totalRows}
              onClick={() => setFrom(from + WINDOW)}
            >
              <ChevronDown aria-hidden /> {t("next")}
            </Button>
          </div>
        </div>
        {rowsError ? (
          <p role="alert" className="text-sm text-destructive">
            {problem(rowsError)}
          </p>
        ) : null}
        <div
          className="relative max-h-[28rem] overflow-auto rounded-lg border"
          tabIndex={0}
          role="region"
          aria-label={t("previewLabel")}
        >
          <table className="w-full min-w-[640px] text-xs">
            <caption className="sr-only">{t("previewLabel")}</caption>
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th scope="col" className="w-12 px-2 py-1.5 text-left font-medium">
                  #
                </th>
                {(rowsWindow?.columns ?? []).map((column) => {
                  const field = fieldOf(column.index);
                  return (
                    <th
                      key={column.index}
                      scope="col"
                      className="px-2 py-1.5 text-left font-medium"
                    >
                      {column.letter}
                      {field ? (
                        <span className="ml-1 rounded bg-primary px-1 text-primary-foreground">
                          {t(`fields.${field}`)}
                        </span>
                      ) : null}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {(rowsWindow?.rows ?? []).map((row) => {
                const isHeader = row.row === mapping.headerRow;
                const outside = row.row < mapping.firstDataRow || row.row > mapping.lastDataRow;
                return (
                  <tr
                    key={row.row}
                    className={cn(
                      "border-t",
                      isHeader && "bg-accent font-semibold",
                      outside && !isHeader && "text-muted-foreground",
                    )}
                  >
                    <th scope="row" className="px-2 py-1 text-left font-mono font-normal">
                      {row.row}
                      {isHeader ? <span className="sr-only"> ({t("headerRowBadge")})</span> : null}
                    </th>
                    {row.cells.map((value, index) => (
                      <td
                        key={index}
                        className="max-w-[18rem] truncate px-2 py-1"
                        title={value ?? ""}
                      >
                        {row.formulas.includes(index) ? (
                          <FunctionSquare
                            className="mr-1 inline size-3 text-info"
                            aria-label={t("formula")}
                          />
                        ) : null}
                        {value}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <section aria-labelledby="templates-heading" className="space-y-3 rounded-lg border p-4">
        <h3 id="templates-heading" className="text-sm font-semibold">
          {t("templates")}
        </h3>
        {templates && templates.length ? (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[14rem] flex-1 space-y-1.5">
                <label htmlFor="template-apply" className="text-sm">
                  {t("templateApply")}
                </label>
                <select
                  id="template-apply"
                  className={selectClass}
                  value={templateId}
                  onChange={(event) => setTemplateId(event.target.value)}
                >
                  <option value="">{t("templateNone")}</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                variant="secondary"
                disabled={!templateId || busy}
                onClick={() => void applyTemplate()}
              >
                <Wand2 aria-hidden /> {t("applyButton")}
              </Button>
            </div>
            <ul className="space-y-1 text-sm">
              {templates.map((template) => (
                <li key={template.id} className="flex items-center justify-between gap-2">
                  <span>
                    {template.name}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({template.createdBy.displayName})
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void deleteTemplate(template)}
                    aria-label={t("deleteTemplate", { name: template.name })}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noTemplates")}</p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1 space-y-1.5">
            <label htmlFor="template-name" className="text-sm">
              {t("templateName")}
            </label>
            <Input
              id="template-name"
              value={templateName}
              maxLength={100}
              onChange={(event) => setTemplateName(event.target.value)}
              aria-describedby="template-hint"
            />
          </div>
          <Button
            variant="outline"
            disabled={!savedMapping || !templateName.trim() || busy}
            onClick={() => void saveTemplate()}
          >
            <Save aria-hidden /> {t("templateSaveButton")}
          </Button>
        </div>
        <p id="template-hint" className="text-xs text-muted-foreground">
          {savedMapping ? t("templateSave") : t("templateNeedsMapping")}
        </p>
      </section>
    </div>
  );
}
