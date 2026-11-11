"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { CircleCheck, OctagonX, Play, Save, TriangleAlert } from "lucide-react";
import {
  BQ_ISSUES,
  type BqIssueCode,
  type BqIssueSeverity,
  type BqRowAction,
} from "@pm-buddy/types";
import { bqImportResponseSchema, type BqImport, type BqIssueWire } from "@pm-buddy/validation";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { useIssueText } from "./bq-labels";
import { selectClass } from "./wizard-columns";

type Notify = (message: { error: boolean; text: string }) => void;
type RowDecision = { action: BqRowAction | ""; reason: string };
type Acceptance = { on: boolean; reason: string };
const SEVERITIES: BqIssueSeverity[] = ["error", "warning", "info"];
const tones: Record<BqIssueSeverity, Tone> = { error: "danger", warning: "warning", info: "info" };
const key = (issue: { sheetIndex: number | null; row: number | null }) =>
  `${issue.sheetIndex}:${issue.row}`;

/**
 * Step 4: the validation report with stable codes, severities and locations; per-row decisions
 * (use quantity × rate, keep the sheet amount with a reason, exclude) and warnings accepted with a
 * reason. Errors block the commit until resolved.
 */
export function ValidateStep({
  projectId,
  current,
  onImport,
  notify,
}: {
  projectId: string;
  current: BqImport;
  onImport: (next: BqImport) => void;
  notify: Notify;
}) {
  const t = useTranslations("bqWizard.validate");
  const issueText = useIssueText();
  const problem = useProblemMessage();
  const report = current.report;
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Record<string, RowDecision>>(() =>
    Object.fromEntries(
      current.resolutions.rows.map((entry) => [
        `${entry.sheetIndex}:${entry.row}`,
        { action: entry.action, reason: entry.reason ?? "" },
      ]),
    ),
  );
  const [accepted, setAccepted] = useState<Record<string, Acceptance>>(() =>
    Object.fromEntries(
      current.resolutions.accepted.map((entry) => [entry.code, { on: true, reason: entry.reason }]),
    ),
  );

  const groups = useMemo(() => {
    const byCode = new Map<BqIssueCode, BqIssueWire[]>();
    for (const issue of report?.issues ?? [])
      byCode.set(issue.code, [...(byCode.get(issue.code) ?? []), issue]);
    return SEVERITIES.map((severity) => ({
      severity,
      codes: [...byCode.entries()].filter(([code]) => BQ_ISSUES[code] === severity),
    }));
  }, [report]);

  async function run(operation: () => Promise<{ import: BqImport }>, success: string) {
    setBusy(true);
    try {
      const result = await operation();
      onImport(result.import);
      notify({ error: false, text: success });
    } catch (error) {
      notify({ error: true, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }

  const validate = () =>
    run(
      () =>
        liveRequest(
          `/projects/${projectId}/bq/imports/${current.id}/validate`,
          bqImportResponseSchema,
          {
            method: "POST",
            body: { version: current.version },
          },
        ),
      t("validated"),
    );

  function save() {
    const rowEntries = Object.entries(rows)
      .filter(([, decision]) => decision.action)
      .map(([entry, decision]) => {
        const [sheetIndex, row] = entry.split(":").map(Number);
        return {
          sheetIndex: sheetIndex!,
          row: row!,
          action: decision.action as BqRowAction,
          ...(decision.action === "sheet" ? { reason: decision.reason.trim() } : {}),
        };
      });
    const acceptedEntries = Object.entries(accepted)
      .filter(([, value]) => value.on)
      .map(([code, value]) => ({ code: code as BqIssueCode, reason: value.reason.trim() }));
    const short =
      rowEntries.some((entry) => entry.action === "sheet" && (entry.reason?.length ?? 0) < 3) ||
      acceptedEntries.some((entry) => entry.reason.length < 3);
    if (short) {
      notify({ error: true, text: t("reasonMissing") });
      return;
    }
    void run(
      () =>
        liveRequest(
          `/projects/${projectId}/bq/imports/${current.id}/resolutions`,
          bqImportResponseSchema,
          {
            method: "PUT",
            body: {
              resolutions: { rows: rowEntries, accepted: acceptedEntries },
              version: current.version,
            },
          },
        ),
      t("saved"),
    );
  }

  if (current.status === "mapped" || !report) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("ready")}</p>
        <Button onClick={() => void validate()} disabled={busy}>
          <Play aria-hidden /> {busy ? t("running") : t("run")}
        </Button>
      </div>
    );
  }

  const severityCount = (severity: BqIssueSeverity) =>
    Object.entries(report.counts).reduce(
      (sum, [code, count]) => (BQ_ISSUES[code as BqIssueCode] === severity ? sum + count : sum),
      0,
    );

  return (
    <div className="space-y-6">
      <div
        role="status"
        className={
          report.readiness.canCommit
            ? "flex items-start gap-3 rounded-lg border border-success/40 bg-success/10 p-4 text-sm"
            : "flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm"
        }
      >
        {report.readiness.canCommit ? (
          <CircleCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
        ) : (
          <TriangleAlert
            className="mt-0.5 size-5 shrink-0 text-warning-foreground dark:text-warning"
            aria-hidden
          />
        )}
        <div className="space-y-1">
          <p className="font-medium">
            {report.readiness.canCommit ? t("canCommit") : t("blocked")}
          </p>
          <p>
            {t("summary", {
              errors: severityCount("error"),
              warnings: severityCount("warning"),
              info: severityCount("info"),
            })}
          </p>
        </div>
      </div>

      {groups.map(({ severity, codes }) =>
        codes.length ? (
          <section key={severity} aria-labelledby={`severity-${severity}`} className="space-y-3">
            <h3
              id={`severity-${severity}`}
              className="flex items-center gap-2 text-base font-semibold"
            >
              {severity === "error" ? (
                <OctagonX className="size-4 text-destructive" aria-hidden />
              ) : null}
              {t(`severity.${severity}`)}
            </h3>
            {codes.map(([code, issues]) => {
              const total = report.counts[code] ?? issues.length;
              const unresolved = report.unresolvedCounts[code] ?? 0;
              const acceptance = accepted[code] ?? { on: false, reason: "" };
              const groupBody = (
                <div className="space-y-3">
                  {severity === "warning" ? (
                    <div className="grid gap-2 rounded-md bg-muted/50 p-3 sm:grid-cols-[auto_1fr] sm:items-center">
                      <label className="flex items-center gap-2 text-sm font-medium">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={acceptance.on}
                          onChange={(event) =>
                            setAccepted({
                              ...accepted,
                              [code]: { ...acceptance, on: event.target.checked },
                            })
                          }
                        />
                        {t("acceptLabel", { title: issueText.title(code) })}
                      </label>
                      <Input
                        aria-label={t("reasonFor", { title: issueText.title(code) })}
                        placeholder={t("reason")}
                        value={acceptance.reason}
                        maxLength={500}
                        disabled={!acceptance.on}
                        onChange={(event) =>
                          setAccepted({
                            ...accepted,
                            [code]: { ...acceptance, reason: event.target.value },
                          })
                        }
                      />
                    </div>
                  ) : null}
                  <div className="relative overflow-x-auto rounded-md border">
                    <table className="w-full min-w-[560px] text-sm">
                      <caption className="sr-only">{issueText.title(code)}</caption>
                      <thead>
                        <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                          <th scope="col" className="px-3 py-2 font-medium">
                            {t("where")}
                          </th>
                          <th scope="col" className="px-3 py-2 font-medium">
                            {t("details")}
                          </th>
                          <th scope="col" className="w-64 px-3 py-2 font-medium">
                            {t("decision")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {issues.map((issue, index) => {
                          const id = key(issue);
                          const decision = rows[id] ?? { action: "", reason: "" };
                          const where =
                            issue.row !== null
                              ? t("rowLabel", { sheet: issue.sheet ?? "", row: issue.row })
                              : issue.sheet
                                ? issue.sheet
                                : t("wholeBq");
                          return (
                            <tr key={`${id}:${index}`} className="border-b align-top last:border-0">
                              <td className="px-3 py-2 whitespace-nowrap">
                                {where}
                                {issue.ref ? (
                                  <span className="block text-xs text-muted-foreground">
                                    {issue.ref}
                                  </span>
                                ) : null}
                              </td>
                              <td className="px-3 py-2">{issueText.detail(issue)}</td>
                              <td className="space-y-2 px-3 py-2">
                                {issue.actions.length && issue.row !== null ? (
                                  <>
                                    <select
                                      className={selectClass}
                                      aria-label={t("decisionFor", { where })}
                                      value={decision.action}
                                      onChange={(event) =>
                                        setRows({
                                          ...rows,
                                          [id]: {
                                            ...decision,
                                            action: event.target.value as BqRowAction | "",
                                          },
                                        })
                                      }
                                    >
                                      <option value="">{t("actions.none")}</option>
                                      {issue.actions.map((action) => (
                                        <option key={action} value={action}>
                                          {t(`actions.${action}`)}
                                        </option>
                                      ))}
                                    </select>
                                    {decision.action === "sheet" ? (
                                      <Input
                                        aria-label={t("reasonForRow", { where })}
                                        placeholder={t("reason")}
                                        value={decision.reason}
                                        maxLength={500}
                                        onChange={(event) =>
                                          setRows({
                                            ...rows,
                                            [id]: { ...decision, reason: event.target.value },
                                          })
                                        }
                                      />
                                    ) : null}
                                  </>
                                ) : issue.resolution ? (
                                  <StatusBadge tone="success">
                                    {t(`actions.${issue.resolution}`)}
                                  </StatusBadge>
                                ) : severity === "warning" ? (
                                  <span className="text-xs text-muted-foreground">
                                    {t("acceptBelow")}
                                  </span>
                                ) : null}
                                {issue.resolution && issue.actions.length ? (
                                  <span className="block text-xs text-muted-foreground">
                                    {t("resolved", { action: t(`actions.${issue.resolution}`) })}
                                  </span>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {issues.length < total ? (
                    <p className="text-xs text-muted-foreground">
                      {t("truncated", { count: issues.length })}
                    </p>
                  ) : null}
                </div>
              );
              return severity === "info" ? (
                <details key={code} className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    {issueText.title(code)} ({total})
                  </summary>
                  <div className="mt-3">{groupBody}</div>
                </details>
              ) : (
                <div key={code} className="space-y-2 rounded-lg border p-3">
                  <h4 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {issueText.title(code)}
                    <StatusBadge tone={tones[severity]}>
                      {t("count", { total, unresolved })}
                    </StatusBadge>
                  </h4>
                  {groupBody}
                </div>
              );
            })}
          </section>
        ) : null,
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={busy}>
          <Save aria-hidden /> {t("save")}
        </Button>
        <Button variant="outline" onClick={() => void validate()} disabled={busy}>
          <Play aria-hidden /> {t("rerun")}
        </Button>
      </div>
    </div>
  );
}
