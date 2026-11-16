"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { TariffBandIssue } from "@pm-buddy/domain";
import { STATEMENT_LIMITS } from "@pm-buddy/types";
import * as wire from "@pm-buddy/validation";
import { CommandDialog, ReasonField, useCommandKey, validReason } from "@/components/payroll/command-dialog";
import { usePayoutProblem } from "@/components/payroll/payout-problem";
import { useStepUp } from "@/components/projects/step-up";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { selectClass } from "@/components/labour/action-dialog";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { liveUpload } from "@/lib/live-api";
import { payrollCommand } from "@/lib/payroll";

type Feedback = { error: boolean; text: string } | null;

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <p
      role={feedback.error ? "alert" : "status"}
      className={feedback.error ? "text-sm text-destructive" : "text-sm"}
    >
      {feedback.text}
    </p>
  );
}

const ACCEPT = [".csv", ".xlsx", ...Object.keys(STATEMENT_LIMITS.contentTypes)].join(",");
const BAND_ISSUES: readonly TariffBandIssue[] = [
  "empty",
  "too_many",
  "not_ascending",
  "invalid_amount",
  "not_whole_shillings",
];
const isBandIssue = (value: string): value is TariffBandIssue =>
  (BAND_ISSUES as readonly string[]).includes(value);

/** "Run now" for a business date and the statement upload (payments.review). */
export function ReconciliationActions({
  date,
  canRun,
  canUpload,
}: {
  date: string;
  canRun: boolean;
  canUpload: boolean;
}) {
  const t = useTranslations("reconciliation");
  const tc = useTranslations("reconciliation.issues");
  const router = useRouter();
  const problem = usePayoutProblem();
  const runKey = useCommandKey();
  const uploadKey = useCommandKey();
  const input = useRef<HTMLInputElement>(null);
  const [runDate, setRunDate] = useState(date);
  const [running, setRunning] = useState(false);
  const [runFeedback, setRunFeedback] = useState<Feedback>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState<Feedback>(null);
  const [uploaded, setUploaded] = useState<wire.StatementResponse | null>(null);
  const tooLarge = file !== null && file.size > STATEMENT_LIMITS.maxBytes;
  const wrongType = file !== null && !/\.(csv|xlsx)$/i.test(file.name);

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = wire.runReconciliationRequestSchema.safeParse({ date: runDate });
    if (!parsed.success) return;
    setRunning(true);
    setRunFeedback(null);
    try {
      const result = await payrollCommand(
        "/payments/reconciliation/runs",
        wire.reconciliationRunResponseSchema,
        parsed.data,
        "POST",
        runKey.value(),
      );
      runKey.renew();
      setRunFeedback({
        error: false,
        text: t("runDone", {
          date: formatCalendarDate(result.run.businessDate),
          created: result.run.created,
          updated: result.run.updated,
          superseded: result.run.superseded,
        }),
      });
      router.refresh();
    } catch (error) {
      setRunFeedback({ error: true, text: problem(error) });
    } finally {
      setRunning(false);
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || tooLarge || wrongType) return;
    setUploading(true);
    setUploadFeedback(null);
    setUploaded(null);
    try {
      const result = await liveUpload(
        "/payments/statements",
        file,
        wire.statementResponseSchema,
        note.trim() ? { note: note.trim() } : {},
        { "Idempotency-Key": uploadKey.value() },
      );
      uploadKey.renew();
      setUploaded(result);
      setFile(null);
      setNote("");
      if (input.current) input.current.value = "";
      router.refresh();
    } catch (error) {
      setUploadFeedback({ error: true, text: problem(error) });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {canRun ? (
        <section aria-labelledby="run-heading" className="min-w-0 space-y-3 rounded-xl border p-4">
          <h2 id="run-heading" className="font-semibold">
            {t("runTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("runHint")}</p>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void run(event)}>
            <Field className="w-auto">
              <FieldLabel htmlFor="run-date">{t("businessDate")}</FieldLabel>
              <Input
                id="run-date"
                type="date"
                value={runDate}
                onChange={(event) => {
                  runKey.renew();
                  setRunDate(event.target.value);
                }}
              />
            </Field>
            <Button type="submit" disabled={running}>
              {t("runNow")}
            </Button>
          </form>
          <FeedbackLine feedback={runFeedback} />
        </section>
      ) : null}
      {canUpload ? (
        <section
          aria-labelledby="upload-heading"
          className="min-w-0 space-y-3 rounded-xl border p-4"
        >
          <h2 id="upload-heading" className="font-semibold">
            {t("uploadTitle")}
          </h2>
          <p role="note" className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-sm">
            {t("layoutNote")}
          </p>
          <form className="space-y-3" onSubmit={(event) => void upload(event)}>
            <Field>
              <FieldLabel htmlFor="statement-file">{t("statementFile")}</FieldLabel>
              <Input
                ref={input}
                id="statement-file"
                type="file"
                accept={ACCEPT}
                onChange={(event) => {
                  uploadKey.renew();
                  setFile(event.target.files?.[0] ?? null);
                }}
                aria-describedby="statement-file-hint"
              />
              <FieldDescription id="statement-file-hint">{t("statementHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="statement-note">{t("statementNote")}</FieldLabel>
              <Textarea
                id="statement-note"
                rows={2}
                maxLength={500}
                value={note}
                onChange={(event) => {
                  uploadKey.renew();
                  setNote(event.target.value);
                }}
              />
            </Field>
            {tooLarge || wrongType ? (
              <p role="alert" className="text-sm text-destructive">
                {t(tooLarge ? "fileTooLarge" : "fileType")}
              </p>
            ) : null}
            <FeedbackLine feedback={uploadFeedback} />
            <Button type="submit" disabled={!file || tooLarge || wrongType || uploading}>
              {t("upload")}
            </Button>
          </form>
          {uploaded ? (
            <div role="status" className="space-y-2 rounded-lg border p-3 text-sm">
              <p className="font-medium">
                {t("uploaded", {
                  name: uploaded.statement.fileName,
                  lines: uploaded.statement.lines,
                  issues: uploaded.issues.length,
                })}
              </p>
              {uploaded.reconciledDates.length ? (
                <p>
                  {t("reconciledDates", {
                    dates: uploaded.reconciledDates.map(formatCalendarDate).join(", "),
                  })}
                </p>
              ) : null}
              {uploaded.issues.length ? (
                <ul className="list-disc space-y-1 pl-5">
                  {uploaded.issues.map((issue) => (
                    <li key={`${issue.row}-${issue.issue}`}>
                      {t("issueRow", { row: issue.row })}: {tc(issue.issue)}
                      {issue.column ? ` (${t(`columns.${issue.column}`)})` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
              <Link className="underline" href={`/payments/statements/${uploaded.statement.id}`}>
                {t("openStatement")}
              </Link>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** Assign, note and resolve one reconciliation item (resolution never posts money). */
export function ItemActions({
  value,
  userId,
}: {
  value: wire.ReconciliationItemResponse;
  userId: string;
}) {
  const t = useTranslations("reconciliation");
  const tv = useTranslations("reconciliation.outcomes");
  const router = useRouter();
  const stepUp = useStepUp();
  const problem = usePayoutProblem();
  const resolveProblem = usePayoutProblem("resolve");
  const assignKey = useCommandKey();
  const noteKey = useCommandKey();
  const resolveKey = useCommandKey();
  const { item, permissions } = value;
  const [assignFeedback, setAssignFeedback] = useState<Feedback>(null);
  const [note, setNote] = useState("");
  const [noteFeedback, setNoteFeedback] = useState<Feedback>(null);
  const [outcome, setOutcome] = useState(value.allowedOutcomes[0] ?? "");
  const [reason, setReason] = useState("");
  const [journalId, setJournalId] = useState("");
  const base = `/payments/reconciliation/items/${item.id}`;
  const open = item.status === "open";
  const resolveBody = {
    version: item.version,
    outcome,
    reason: reason.trim(),
    ...(outcome === "charge_journal" ? { journalId: journalId.trim() } : {}),
  };
  const resolveParsed = wire.resolveReconciliationItemRequestSchema.safeParse(resolveBody);

  async function assign(ownerId: string | null) {
    setAssignFeedback(null);
    assignKey.renew();
    try {
      await payrollCommand(
        `${base}/assign`,
        wire.reconciliationItemResponseSchema,
        { version: item.version, ownerId },
        "POST",
        assignKey.value(),
      );
      router.refresh();
    } catch (error) {
      setAssignFeedback({ error: true, text: problem(error) });
    }
  }

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = wire.noteReconciliationItemRequestSchema.safeParse({ note: note.trim() });
    if (!parsed.success) return;
    setNoteFeedback(null);
    try {
      await payrollCommand(
        `${base}/notes`,
        wire.reconciliationItemResponseSchema,
        parsed.data,
        "POST",
        noteKey.value(),
      );
      noteKey.renew();
      setNote("");
      setNoteFeedback({ error: false, text: t("noteAdded") });
      router.refresh();
    } catch (error) {
      setNoteFeedback({ error: true, text: problem(error) });
    }
  }

  return (
    <div className="space-y-4">
      {permissions.canAssign && open ? (
        <section aria-labelledby="assign-heading" className="space-y-2">
          <h2 id="assign-heading" className="font-semibold">
            {t("owner")}
          </h2>
          <p className="text-sm">{item.owner?.displayName ?? t("unassigned")}</p>
          <div className="flex flex-wrap gap-2">
            {item.owner?.id !== userId ? (
              <Button type="button" size="sm" variant="outline" onClick={() => void assign(userId)}>
                {t("assignMe")}
              </Button>
            ) : null}
            {item.owner ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => void assign(null)}>
                {t("unassign")}
              </Button>
            ) : null}
          </div>
          <FeedbackLine feedback={assignFeedback} />
        </section>
      ) : null}
      {permissions.canNote ? (
        <section aria-labelledby="note-heading" className="space-y-2">
          <h2 id="note-heading" className="font-semibold">
            {t("addNote")}
          </h2>
          <form className="max-w-xl space-y-2" onSubmit={(event) => void addNote(event)}>
            <Field>
              <FieldLabel htmlFor="item-note">{t("note")}</FieldLabel>
              <Textarea
                id="item-note"
                rows={3}
                maxLength={1_000}
                value={note}
                onChange={(event) => {
                  noteKey.renew();
                  setNote(event.target.value);
                }}
              />
            </Field>
            <FeedbackLine feedback={noteFeedback} />
            <Button type="submit" size="sm" disabled={note.trim().length < 3}>
              {t("saveNote")}
            </Button>
          </form>
        </section>
      ) : null}
      {permissions.canResolve && open && value.allowedOutcomes.length ? (
        <section aria-labelledby="resolve-heading" className="space-y-2">
          <h2 id="resolve-heading" className="font-semibold">
            {t("resolve")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("resolveHint")}</p>
          <CommandDialog
            label={t("resolve")}
            variant="default"
            title={t("resolveTitle")}
            description={t("resolveHint")}
            submitLabel={t("resolve")}
            submitDisabled={!resolveParsed.success || !validReason(reason)}
            problem={resolveProblem}
            onOpen={() => {
              resolveKey.renew();
              setReason("");
              setJournalId("");
              setOutcome(value.allowedOutcomes[0] ?? "");
            }}
            onSubmit={async () => {
              if (!resolveParsed.success) return;
              await stepUp.run(() =>
                payrollCommand(
                  `${base}/resolve`,
                  wire.reconciliationItemResponseSchema,
                  resolveParsed.data as Record<string, unknown>,
                  "POST",
                  resolveKey.value(),
                ),
              );
              router.refresh();
            }}
          >
            <Field>
              <FieldLabel htmlFor="resolve-outcome">{t("outcome")}</FieldLabel>
              <select
                id="resolve-outcome"
                className={selectClass}
                value={outcome}
                onChange={(event) => {
                  resolveKey.renew();
                  setOutcome(event.target.value as typeof outcome);
                }}
              >
                {value.allowedOutcomes.map((entry) => (
                  <option key={entry} value={entry}>
                    {tv(entry)}
                  </option>
                ))}
              </select>
            </Field>
            {outcome === "charge_journal" ? (
              <Field>
                <FieldLabel htmlFor="resolve-journal">{t("journalId")}</FieldLabel>
                <Input
                  id="resolve-journal"
                  value={journalId}
                  onChange={(event) => {
                    resolveKey.renew();
                    setJournalId(event.target.value);
                  }}
                  aria-describedby="resolve-journal-hint"
                />
                <FieldDescription id="resolve-journal-hint">{t("journalHint")}</FieldDescription>
              </Field>
            ) : null}
            <ReasonField
              value={reason}
              onChange={(next) => {
                resolveKey.renew();
                setReason(next);
              }}
            />
          </CommandDialog>
        </section>
      ) : null}
      {stepUp.dialog}
    </div>
  );
}

type BandRow = { upTo: string; charge: string };

/**
 * The effective-dated B2C charges tariff (§12): versions are never edited, a new one starts on a
 * date. DEMO bands are placeholders until the company confirms its own Safaricom tariff.
 */
export function TariffsPanel({ value }: { value: wire.TariffsResponse }) {
  const t = useTranslations("reconciliation.tariffs");
  const tb = useTranslations("reconciliation.bandIssues");
  const router = useRouter();
  const stepUp = useStepUp();
  const problem = usePayoutProblem();
  const key = useCommandKey();
  const base = value.inForce?.bands ?? [];
  const [effectiveFrom, setEffectiveFrom] = useState(value.today);
  const [status, setStatus] = useState<"demo" | "verified">("demo");
  const [source, setSource] = useState("");
  const [rows, setRows] = useState<BandRow[]>(
    base.length
      ? base.map((band) => ({
          upTo: String(band.upToMinor / 100),
          charge: String(band.chargeMinor / 100),
        }))
      : [{ upTo: "", charge: "" }],
  );
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const toMinor = (text: string) =>
    /^\d{1,9}$/.test(text.replace(/[,\s]/g, "")) ? Number(text.replace(/[,\s]/g, "")) * 100 : NaN;
  const body = {
    kind: "b2c",
    effectiveFrom,
    status,
    source: source.trim(),
    bands: rows.map((row) => ({ upToMinor: toMinor(row.upTo), chargeMinor: toMinor(row.charge) })),
  };
  const parsed = wire.putTariffRequestSchema.safeParse(body);
  const issues = parsed.success
    ? []
    : [
        ...new Set(
          parsed.error.issues
            .map((issue) => issue.message)
            .filter((message) => message.startsWith("bands_"))
            .map((message) => message.slice("bands_".length))
            .filter(isBandIssue),
        ),
      ];
  const edit = (index: number, field: keyof BandRow) => (event: { target: { value: string } }) => {
    key.renew();
    setRows((current) =>
      current.map((row, at) => (at === index ? { ...row, [field]: event.target.value } : row)),
    );
  };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!parsed.success) return;
    setBusy(true);
    setFeedback(null);
    try {
      await stepUp.run(() =>
        payrollCommand(
          "/payments/tariffs",
          wire.tariffsResponseSchema,
          parsed.data as Record<string, unknown>,
          "PUT",
          key.value(),
        ),
      );
      key.renew();
      setFeedback({ error: false, text: t("saved") });
      router.refresh();
    } catch (error) {
      setFeedback({ error: true, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <p role="note" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
        {t("demoNote")}
      </p>
      <section aria-labelledby="versions-heading" className="space-y-3">
        <h2 id="versions-heading" className="text-lg font-semibold">
          {t("versions")}
        </h2>
        {value.versions.map((version) => (
          <article
            key={version.id}
            aria-label={t("versionLabel", { date: formatCalendarDate(version.effectiveFrom) })}
            className="min-w-0 space-y-2 rounded-lg border p-3"
          >
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {formatCalendarDate(version.effectiveFrom)} –{" "}
                {version.effectiveTo ? formatCalendarDate(version.effectiveTo) : t("ongoing")}
              </span>
              <StatusBadge tone={version.status === "demo" ? "warning" : "success"}>
                {t(`status.${version.status}`)}
              </StatusBadge>
              {version.inForce ? <StatusBadge tone="info">{t("inForce")}</StatusBadge> : null}
            </p>
            <p className="break-words text-xs text-muted-foreground">{version.source}</p>
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              {version.bands.map((band, index) => (
                <li key={band.upToMinor}>
                  {t("band", {
                    from: formatKES(index === 0 ? 100 : version.bands[index - 1]!.upToMinor + 100),
                    upTo: formatKES(band.upToMinor),
                    charge: formatKES(band.chargeMinor),
                  })}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {version.createdBy ? version.createdBy.displayName : t("seeded")}
            </p>
          </article>
        ))}
        {!value.versions.length ? <p>{t("none")}</p> : null}
      </section>
      {value.canManage ? (
        <section aria-labelledby="new-tariff-heading" className="space-y-3 rounded-xl border p-4">
          <h2 id="new-tariff-heading" className="text-lg font-semibold">
            {t("newVersion")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("newHint")}</p>
          <form className="space-y-3" onSubmit={(event) => void save(event)}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="tariff-from">{t("effectiveFrom")}</FieldLabel>
                <Input
                  id="tariff-from"
                  type="date"
                  value={effectiveFrom}
                  onChange={(event) => {
                    key.renew();
                    setEffectiveFrom(event.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="tariff-status">{t("statusLabel")}</FieldLabel>
                <select
                  id="tariff-status"
                  className={selectClass}
                  value={status}
                  onChange={(event) => {
                    key.renew();
                    setStatus(event.target.value as typeof status);
                  }}
                >
                  <option value="demo">{t("status.demo")}</option>
                  <option value="verified">{t("status.verified")}</option>
                </select>
              </Field>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("bands")}</legend>
              {rows.map((row, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <Field className="w-36">
                    <FieldLabel htmlFor={`band-${index}-upto`}>
                      {t("upTo", { band: index + 1 })}
                    </FieldLabel>
                    <Input
                      id={`band-${index}-upto`}
                      inputMode="numeric"
                      value={row.upTo}
                      onChange={edit(index, "upTo")}
                    />
                  </Field>
                  <Field className="w-36">
                    <FieldLabel htmlFor={`band-${index}-charge`}>
                      {t("charge", { band: index + 1 })}
                    </FieldLabel>
                    <Input
                      id={`band-${index}-charge`}
                      inputMode="numeric"
                      value={row.charge}
                      onChange={edit(index, "charge")}
                    />
                  </Field>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={rows.length === 1}
                    onClick={() => {
                      key.renew();
                      setRows((current) => current.filter((_, at) => at !== index));
                    }}
                  >
                    {t("removeBand", { band: index + 1 })}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  key.renew();
                  setRows((current) => [...current, { upTo: "", charge: "" }]);
                }}
              >
                {t("addBand")}
              </Button>
            </fieldset>
            <Field>
              <FieldLabel htmlFor="tariff-source">{t("source")}</FieldLabel>
              <Textarea
                id="tariff-source"
                rows={2}
                maxLength={2_000}
                value={source}
                onChange={(event) => {
                  key.renew();
                  setSource(event.target.value);
                }}
                aria-describedby="tariff-source-hint"
              />
              <FieldDescription id="tariff-source-hint">{t("sourceHint")}</FieldDescription>
            </Field>
            {issues.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
                {issues.map((issue) => (
                  <li key={issue}>{tb(issue)}</li>
                ))}
              </ul>
            ) : null}
            <FeedbackLine feedback={feedback} />
            <Button type="submit" disabled={busy || !parsed.success}>
              {t("save")}
            </Button>
          </form>
        </section>
      ) : null}
      {stepUp.dialog}
    </div>
  );
}
