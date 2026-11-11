"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheck,
  FileSpreadsheet,
  Lock,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { isImportResumable } from "@pm-buddy/domain";
import { BQ_IMPORT_LIMITS, type BqImportStatus } from "@pm-buddy/types";
import {
  bqImportResponseSchema,
  bqImportsResponseSchema,
  bqPreviewResponseSchema,
  type BqImport,
  type BqImportSummary,
  type BqMappingInput,
  type BqPreviewResponse,
} from "@pm-buddy/validation";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDateTime, formatKES } from "@/lib/format";
import { liveRequest, liveUpload } from "@/lib/live-api";
import { cn } from "@/lib/utils";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { ColumnsStep, selectClass } from "./wizard-columns";
import { ValidateStep } from "./wizard-validate";

const STEPS = ["upload", "sheets", "columns", "validate", "review"] as const;
type Step = (typeof STEPS)[number];
const statusTone: Record<BqImportStatus, Tone> = {
  uploaded: "neutral",
  parsed: "info",
  mapped: "info",
  validated: "info",
  committed: "success",
  failed: "danger",
  abandoned: "neutral",
  superseded: "neutral",
};
const ACCEPT =
  ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";

function stepFor(current: BqImport | null): Step {
  if (!current) return "upload";
  switch (current.status) {
    case "parsed":
      return "sheets";
    case "mapped":
      return "validate";
    case "validated":
      return current.report?.readiness.canCommit ? "review" : "validate";
    case "committed":
      return "review";
    default:
      return "upload";
  }
}

function available(step: Step, current: BqImport | null): boolean {
  if (step === "upload") return true;
  if (!current?.sheets) return false;
  const status = current.status;
  if (step === "sheets" || step === "columns")
    return status === "parsed" || status === "mapped" || status === "validated";
  if (step === "validate") return status === "mapped" || status === "validated";
  return status === "validated" || status === "committed";
}

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * The live BQ import wizard: upload → sheets → columns → validate → review and commit. Each step
 * is saved on the server, so an import can be resumed later; nothing changes the BQ until commit.
 */
export function ImportWizard({
  projectId,
  initial,
  imports: initialImports,
}: {
  projectId: string;
  initial: BqImport | null;
  imports: BqImportSummary[];
}) {
  const t = useTranslations("bqWizard");
  const tStatus = useTranslations("bqWizard.status");
  const problem = useProblemMessage();
  const [current, setCurrent] = useState<BqImport | null>(initial);
  const [imports, setImports] = useState(initialImports);
  const [step, setStep] = useState<Step>(stepFor(initial));
  const [draft, setDraft] = useState<BqMappingInput | null>(initial?.mapping ?? null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BqPreviewResponse | null>(null);
  const stepButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);

  // Moving between steps puts focus on the new step's heading (not on first render).
  useEffect(() => {
    if (mounted.current) heading.current?.focus();
    mounted.current = true;
  }, [step]);

  function go(next: Step, target: BqImport | null = current) {
    setStep(next);
    if (next === "review" && target?.status === "validated") void loadPreview(target);
  }

  function adopt(next: BqImport, goTo?: Step) {
    setCurrent(next);
    setDraft(next.mapping ? structuredClone(next.mapping) : null);
    setPreview(null);
    window.history.replaceState(null, "", `?import=${next.id}`);
    if (goTo) go(goTo, next);
    void refreshList();
  }

  async function refreshList() {
    try {
      setImports(
        (await liveRequest(`/projects/${projectId}/bq/imports`, bqImportsResponseSchema)).imports,
      );
    } catch {
      // The list is a convenience; the current import stays usable.
    }
  }

  async function run<T>(operation: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setMessage(null);
    try {
      return await operation();
    } catch (error) {
      setMessage({ error: true, text: problem(error) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    if (!file) return;
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      setMessage({ error: true, text: t("upload.wrongType") });
      return;
    }
    if (file.size > BQ_IMPORT_LIMITS.maxFileBytes) {
      setMessage({ error: true, text: t("upload.tooLarge") });
      return;
    }
    const result = await run(() =>
      liveUpload(`/projects/${projectId}/bq/imports`, file, bqImportResponseSchema),
    );
    if (!result) return;
    setFile(null);
    adopt(result.import, result.import.status === "parsed" ? "sheets" : "upload");
    if (result.import.status === "failed")
      setMessage({
        error: true,
        text: t("upload.failed", {
          reason: t(`failures.${result.import.failureCode ?? "workbook-unreadable"}`),
        }),
      });
  }

  async function open(summary: BqImportSummary) {
    const result = await run(() =>
      liveRequest(`/projects/${projectId}/bq/imports/${summary.id}`, bqImportResponseSchema),
    );
    if (result) adopt(result.import, stepFor(result.import));
  }

  async function parseAgain(summary: BqImportSummary) {
    const result = await run(() =>
      liveRequest(`/projects/${projectId}/bq/imports/${summary.id}/parse`, bqImportResponseSchema, {
        method: "POST",
      }),
    );
    if (result) adopt(result.import, stepFor(result.import));
  }

  async function abandon() {
    if (!current) return;
    const result = await run(() =>
      liveRequest(
        `/projects/${projectId}/bq/imports/${current.id}/abandon`,
        bqImportResponseSchema,
        {
          method: "POST",
          body: { version: current.version },
        },
      ),
    );
    if (result) {
      adopt(result.import, "upload");
      setMessage({ error: false, text: t("upload.abandoned") });
    }
  }

  async function saveMapping() {
    if (!current || !draft) return;
    const result = await run(() =>
      liveRequest(
        `/projects/${projectId}/bq/imports/${current.id}/mapping`,
        bqImportResponseSchema,
        {
          method: "PUT",
          body: { mapping: draft, version: current.version },
        },
      ),
    );
    if (result) {
      adopt(result.import, "validate");
      setMessage({ error: false, text: t("columns.saved") });
    }
  }

  async function loadPreview(target: BqImport) {
    const result = await run(() =>
      liveRequest(
        `/projects/${projectId}/bq/imports/${target.id}/preview`,
        bqPreviewResponseSchema,
      ),
    );
    if (result) setPreview(result);
  }

  async function commit() {
    if (!current) return;
    const result = await run(() =>
      liveRequest(
        `/projects/${projectId}/bq/imports/${current.id}/commit`,
        bqImportResponseSchema,
        {
          method: "POST",
          body: { version: current.version },
        },
      ),
    );
    if (result) {
      adopt(result.import, "review");
      setMessage({ error: false, text: t("review.committed") });
    }
  }

  useEffect(() => {
    if (initial?.status === "validated" && stepFor(initial) === "review") void loadPreview(initial);
    // Only the import the page opened with; later imports load their preview when adopted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onStepKey(event: React.KeyboardEvent, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    for (let next = index + direction; next >= 0 && next < STEPS.length; next += direction) {
      if (available(STEPS[next]!, current)) {
        stepButtons.current[next]?.focus();
        return;
      }
    }
  }

  const index = STEPS.indexOf(step);
  const resumable = imports.filter(
    (entry) => isImportResumable(entry.status) && entry.id !== current?.id,
  );
  const updateSheet = (sheetIndex: number, patch: Partial<BqMappingInput["sheets"][number]>) =>
    draft &&
    setDraft({
      ...draft,
      sheets: draft.sheets.map((sheet) =>
        sheet.sheetIndex === sheetIndex ? { ...sheet, ...patch } : sheet,
      ),
    });
  const numberInput = (value: string) =>
    Math.max(1, Math.min(BQ_IMPORT_LIMITS.maxRowsPerSheet + 1, Number(value) || 1));

  return (
    <div className="space-y-6">
      <ol className="grid gap-2 sm:grid-cols-5" aria-label={t("stepsLabel")}>
        {STEPS.map((key, position) => {
          const reachable = available(key, current);
          const done = position < index && reachable;
          return (
            <li key={key}>
              <button
                ref={(element) => {
                  stepButtons.current[position] = element;
                }}
                type="button"
                disabled={!reachable}
                onClick={() => go(key)}
                onKeyDown={(event) => onStepKey(event, position)}
                aria-current={key === step ? "step" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  key === step && "border-primary bg-accent text-accent-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                    key === step && "border-primary bg-primary text-primary-foreground",
                  )}
                  aria-hidden
                >
                  {done ? (
                    <Check className="size-3.5" />
                  ) : reachable ? (
                    position + 1
                  ) : (
                    <Lock className="size-3" />
                  )}
                </span>
                <span className="truncate">{t(`steps.${key}`)}</span>
                <span className="sr-only">
                  {key === step ? t("stepState.current") : reachable ? "" : t("stepState.locked")}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {current ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-4 py-3 text-sm">
          <FileSpreadsheet className="size-4 text-primary" aria-hidden />
          <span className="font-medium break-all">{current.fileName}</span>
          <StatusBadge tone={statusTone[current.status]}>{tStatus(current.status)}</StatusBadge>
          <span className="text-muted-foreground">
            {t("upload.uploadedBy", {
              date: formatDateTime(current.createdAt),
              name: current.uploadedBy.displayName,
            })}
          </span>
        </div>
      ) : null}

      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={cn(
            "rounded-md border p-3 text-sm",
            message.error
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-success/40 bg-success/10",
          )}
        >
          {message.text}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 ref={heading} tabIndex={-1} className="outline-none">
              {t(`steps.${step}`)}
            </h2>
          </CardTitle>
          <CardDescription>{t(`help.${step}`)}</CardDescription>
        </CardHeader>
        <CardContent>
          {step === "upload" ? (
            <div className="space-y-6">
              <div
                className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 text-center"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const dropped = event.dataTransfer.files[0];
                  if (dropped) setFile(dropped);
                }}
              >
                <Upload className="size-8 text-primary" aria-hidden />
                <label htmlFor="bq-file" className="font-medium">
                  {t("upload.choose")}
                </label>
                <Input
                  id="bq-file"
                  type="file"
                  accept={ACCEPT}
                  className="max-w-sm"
                  aria-describedby="bq-file-help"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                <p id="bq-file-help" className="text-xs text-muted-foreground">
                  {t("upload.drop")}
                </p>
                {file ? (
                  <p className="text-sm">
                    {t("upload.selected", { name: file.name, size: sizeLabel(file.size) })}
                  </p>
                ) : null}
                <Button onClick={() => void upload()} disabled={!file || busy}>
                  <Upload aria-hidden /> {busy ? t("upload.uploading") : t("upload.start")}
                </Button>
              </div>
              {current ? (
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("upload.file")}</dt>
                    <dd className="break-all">
                      {current.fileName} · {current.fileType.toUpperCase()} ·{" "}
                      {sizeLabel(current.fileSizeBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("upload.sha")}</dt>
                    <dd className="font-mono text-xs break-all">{current.fileSha256}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("upload.scanLabel")}</dt>
                    <dd>{t(`upload.scan.${current.scanStatus}`)}</dd>
                  </div>
                  {current.failureCode ? (
                    <div>
                      <dt className="text-xs text-muted-foreground">{t("upload.failureLabel")}</dt>
                      <dd>{t(`failures.${current.failureCode}`)}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
              <section aria-labelledby="resume-heading" className="space-y-2">
                <h3 id="resume-heading" className="text-sm font-semibold">
                  {t("upload.resumeTitle")}
                </h3>
                {resumable.length ? (
                  <ul className="divide-y rounded-lg border">
                    {resumable.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                      >
                        <span className="font-medium break-all">{entry.fileName}</span>
                        <StatusBadge tone={statusTone[entry.status]}>
                          {tStatus(entry.status)}
                        </StatusBadge>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(entry.updatedAt)}
                        </span>
                        <span className="ml-auto flex gap-2">
                          {entry.status === "uploaded" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void parseAgain(entry)}
                            >
                              <RotateCcw aria-hidden /> {t("upload.parseAgain")}
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void open(entry)}
                          >
                            {t("upload.resume", { name: entry.fileName })}
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("upload.resumeEmpty")}</p>
                )}
              </section>
            </div>
          ) : null}

          {step === "sheets" && current?.sheets && draft ? (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <caption className="sr-only">{t("sheets.caption")}</caption>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 pr-2 font-medium">
                      {t("sheets.include")}
                    </th>
                    <th scope="col" className="py-2 pr-2 font-medium">
                      {t("sheets.sheet")}
                    </th>
                    <th scope="col" className="py-2 pr-2 font-medium">
                      {t("sheets.detected")}
                    </th>
                    <th scope="col" className="py-2 pr-2 font-medium">
                      {t("sheets.role")}
                    </th>
                    <th scope="col" className="py-2 pr-2 font-medium">
                      {t("sheets.billNumber")}
                    </th>
                    <th scope="col" className="py-2 pr-2 font-medium">
                      {t("sheets.billTitle")}
                    </th>
                    <th scope="col" className="py-2 pr-2 font-medium">
                      {t("sheets.headerRow")}
                    </th>
                    <th scope="col" className="py-2 pr-2 font-medium">
                      {t("sheets.firstRow")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("sheets.lastRow")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {draft.sheets.map((sheet) => {
                    const summary = current.sheets![sheet.sheetIndex]!;
                    const label = summary.name;
                    return (
                      <tr key={sheet.sheetIndex} className="border-b align-top">
                        <td className="py-2 pr-2">
                          <input
                            type="checkbox"
                            className="mt-2 size-4 accent-primary"
                            checked={sheet.include}
                            aria-label={t("sheets.includeSheet", { name: label })}
                            onChange={(event) =>
                              updateSheet(sheet.sheetIndex, { include: event.target.checked })
                            }
                          />
                        </td>
                        <td className="py-2 pr-2">
                          <span className="font-medium">{label}</span>
                          <span className="block text-xs text-muted-foreground">
                            {t("sheets.rows", { count: summary.usedRows })}
                            {summary.hidden ? ` · ${t("sheets.hidden")}` : ""}
                            {summary.templateId ? ` · ${t("sheets.template")}` : ""}
                          </span>
                        </td>
                        <td className="py-2 pr-2">
                          <StatusBadge tone={summary.kind === "other" ? "neutral" : "info"}>
                            {t(`sheets.kinds.${summary.kind}`)}
                          </StatusBadge>
                          <span className="block text-xs text-muted-foreground">
                            {t("sheets.confidence", {
                              value: Math.round(summary.kindConfidence * 100),
                            })}
                          </span>
                        </td>
                        <td className="py-2 pr-2">
                          <select
                            className={selectClass}
                            aria-label={t("sheets.roleFor", { name: label })}
                            value={sheet.role}
                            disabled={!sheet.include}
                            onChange={(event) =>
                              updateSheet(sheet.sheetIndex, {
                                role: event.target.value as "bill" | "summary",
                              })
                            }
                          >
                            <option value="bill">{t("sheets.roles.bill")}</option>
                            <option value="summary">{t("sheets.roles.summary")}</option>
                          </select>
                        </td>
                        <td className="w-24 py-2 pr-2">
                          <Input
                            aria-label={t("sheets.billNumberFor", { name: label })}
                            value={sheet.billNumber}
                            maxLength={20}
                            disabled={!sheet.include || sheet.role !== "bill"}
                            onChange={(event) =>
                              updateSheet(sheet.sheetIndex, { billNumber: event.target.value })
                            }
                          />
                        </td>
                        <td className="min-w-48 py-2 pr-2">
                          <Input
                            aria-label={t("sheets.billTitleFor", { name: label })}
                            value={sheet.billTitle}
                            maxLength={200}
                            disabled={!sheet.include || sheet.role !== "bill"}
                            onChange={(event) =>
                              updateSheet(sheet.sheetIndex, { billTitle: event.target.value })
                            }
                          />
                        </td>
                        {(["headerRow", "firstDataRow", "lastDataRow"] as const).map((field) => (
                          <td key={field} className="w-24 py-2 pr-2">
                            <Input
                              type="number"
                              min={1}
                              aria-label={t(`sheets.${field}For`, { name: label })}
                              value={sheet[field]}
                              disabled={!sheet.include}
                              onChange={(event) =>
                                updateSheet(sheet.sheetIndex, {
                                  [field]: numberInput(event.target.value),
                                })
                              }
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {step === "columns" && current && draft ? (
            <ColumnsStep
              key={`${current.id}:${current.version}`}
              projectId={projectId}
              current={current}
              draft={draft}
              setDraft={setDraft}
              onImport={(next) => adopt(next)}
              notify={setMessage}
            />
          ) : null}

          {step === "validate" && current ? (
            <ValidateStep
              key={`${current.id}:${current.version}`}
              projectId={projectId}
              current={current}
              onImport={(next) =>
                adopt(next, next.report?.readiness.canCommit ? "review" : "validate")
              }
              notify={setMessage}
            />
          ) : null}

          {step === "review" && current ? (
            current.status === "committed" ? (
              <div className="space-y-4 text-center">
                <CircleCheck className="mx-auto size-10 text-success" aria-hidden />
                <p className="font-medium">{t("review.committed")}</p>
                <Button asChild>
                  <Link href={`/projects/${projectId}/bq`}>{t("review.openBq")}</Link>
                </Button>
              </div>
            ) : preview ? (
              <div className="space-y-6">
                <p className="text-sm">
                  {preview.existingDraft
                    ? t("review.existing", {
                        version: preview.existingDraft.versionNo,
                        items: preview.existingDraft.itemCount,
                        total: formatKES(preview.existingDraft.grandTotalMinor),
                        file: preview.existingDraft.sourceFileName ?? "none",
                      })
                    : t("review.noExisting")}
                </p>
                <div className="relative overflow-x-auto rounded-lg border">
                  <table className="w-full min-w-[560px] text-sm">
                    <caption className="sr-only">{t("review.bills")}</caption>
                    <thead>
                      <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("review.bill")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          {t("review.sections")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          {t("review.items")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          {t("review.total")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          {t("review.sheetTotal")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.bills.map((bill) => (
                        <tr key={bill.number} className="border-b">
                          <th scope="row" className="px-3 py-2 text-left font-normal">
                            {t("review.billName", { number: bill.number, title: bill.title })}
                          </th>
                          <td className="px-3 py-2 text-right tabular-nums">{bill.sectionCount}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{bill.itemCount}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatKES(bill.totalMinor)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {bill.sheetTotalMinor === null
                              ? t("review.unavailable")
                              : formatKES(bill.sheetTotalMinor)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <dl className="grid gap-2 text-sm sm:grid-cols-3">
                  <div className="rounded-lg border p-3">
                    <dt className="text-xs text-muted-foreground">{t("review.subtotal")}</dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {formatKES(preview.totals.subtotalMinor)}
                    </dd>
                  </div>
                  <div className="rounded-lg border p-3">
                    <dt className="text-xs text-muted-foreground">
                      {t("review.vat", { rate: preview.totals.vatRatePercent })}
                    </dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {formatKES(preview.totals.vatMinor)}
                    </dd>
                  </div>
                  <div className="rounded-lg border bg-accent/50 p-3">
                    <dt className="text-xs text-muted-foreground">{t("review.grandTotal")}</dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {formatKES(preview.totals.grandTotalMinor)}
                    </dd>
                  </div>
                </dl>
                {preview.differences.length ? (
                  <section aria-labelledby="changes-heading" className="space-y-2">
                    <h3 id="changes-heading" className="text-sm font-semibold">
                      {t("review.changes")}
                    </h3>
                    <ul className="space-y-1 text-sm">
                      {preview.differences.map((entry) => (
                        <li
                          key={`${entry.billNumber}:${entry.change}`}
                          className="flex flex-wrap gap-2"
                        >
                          <StatusBadge tone={entry.change === "unchanged" ? "neutral" : "info"}>
                            {t(`review.change.${entry.change}`)}
                          </StatusBadge>
                          {t("review.billName", { number: entry.billNumber, title: entry.title })}
                          <span className="text-muted-foreground">
                            {entry.currentTotalMinor === null
                              ? "—"
                              : formatKES(entry.currentTotalMinor)}{" "}
                            → {entry.newTotalMinor === null ? "—" : formatKES(entry.newTotalMinor)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">{t("review.replace")}</p>
                  </section>
                ) : null}
                {preview.readiness.canCommit ? null : (
                  <p role="status" className="text-sm text-destructive">
                    {t("review.blocked")}
                  </p>
                )}
                <Button
                  onClick={() => void commit()}
                  disabled={busy || !preview.readiness.canCommit}
                >
                  <Check aria-hidden /> {busy ? t("review.committing") : t("review.commit")}
                </Button>
              </div>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {t("review.loading")}
              </p>
            )
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-between gap-2">
          <div className="flex gap-2">
            {index > 0 ? (
              <Button variant="ghost" onClick={() => go(STEPS[index - 1]!)}>
                <ArrowLeft aria-hidden /> {t("back")}
              </Button>
            ) : (
              <Button asChild variant="ghost">
                <Link href={`/projects/${projectId}/bq`}>
                  <ArrowLeft aria-hidden /> {t("cancel")}
                </Link>
              </Button>
            )}
            {current && isImportResumable(current.status) ? (
              <Button variant="ghost" disabled={busy} onClick={() => void abandon()}>
                <Trash2 aria-hidden /> {t("upload.abandon")}
              </Button>
            ) : null}
          </div>
          {step === "sheets" ? (
            <Button
              onClick={() => go("columns")}
              disabled={!draft?.sheets.some((sheet) => sheet.include && sheet.role === "bill")}
            >
              {t("next")} <ArrowRight aria-hidden />
            </Button>
          ) : null}
          {step === "columns" ? (
            <Button onClick={() => void saveMapping()} disabled={busy}>
              {t("columns.save")} <ArrowRight aria-hidden />
            </Button>
          ) : null}
          {step === "validate" && available("review", current) ? (
            <Button onClick={() => go("review")}>
              {t("next")} <ArrowRight aria-hidden />
            </Button>
          ) : null}
        </CardFooter>
      </Card>
    </div>
  );
}
