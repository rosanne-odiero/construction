"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { nairobiDate, REASON_LIMITS } from "@pm-buddy/domain";
import {
  COST_CATEGORIES,
  COST_MEASURES,
  SPENDING_LIMITS,
  type CostCategory,
  type CostMeasure,
} from "@pm-buddy/types";
import { journalResponseSchema } from "@pm-buddy/validation";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { parseKesInput } from "@/lib/spending";
import { spendingSelectClass } from "./spending-action";
import { TagPicker, type CostTag } from "./tag-picker";

type Line = {
  key: string;
  measure: CostMeasure;
  category: CostCategory;
  tag: CostTag | null;
  sign: "increase" | "decrease";
  amount: string;
  counterpartyName: string;
  paymentReference: string;
  occurredOn: string;
};

// Keys become element IDs: deterministic, so the server and the browser render the same ones.
const newLine = (number: number): Line => ({
  key: `journal-line-${number}`,
  measure: "accrued",
  category: "preliminaries",
  tag: null,
  sign: "increase",
  amount: "",
  counterpartyName: "",
  paymentReference: "",
  occurredOn: nairobiDate(),
});

/**
 * Proposes a manual cost journal (maker-checker): another finance manager approves it before it
 * posts to the cost ledger. Corrections of posted entries use the ledger's reversal instead.
 */
export function JournalForm({
  projects,
}: {
  projects: { id: string; code: string; name: string }[];
}) {
  const t = useTranslations("spending.journalForm");
  const tCategory = useTranslations("spending.categories");
  const tMeasure = useTranslations("spending.measures");
  const problem = useP2pProblem();
  const router = useRouter();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [newLine(1)]);
  const [added, setAdded] = useState(1);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const update = (key: string, patch: Partial<Line>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (Array.from(reason.trim()).length < REASON_LIMITS.min) return setFailure(t("reasonShort"));
    const body = [];
    for (const [index, line] of lines.entries()) {
      const minor = parseKesInput(line.amount);
      if (minor === null) return setFailure(t("amountInvalid", { line: index + 1 }));
      if (!line.tag) return setFailure(t("tagRequired", { line: index + 1 }));
      body.push({
        measure: line.measure,
        category: line.category,
        ...(line.tag.kind === "item"
          ? { bqItemLineageId: line.tag.lineageId }
          : { costCodeId: line.tag.id }),
        counterpartyKind: line.counterpartyName.trim() ? "other" : "none",
        ...(line.counterpartyName.trim() ? { counterpartyName: line.counterpartyName.trim() } : {}),
        ...(line.paymentReference.trim() ? { paymentReference: line.paymentReference.trim() } : {}),
        occurredOn: line.occurredOn,
        amountMinor: line.sign === "decrease" ? -minor : minor,
      });
    }
    setBusy(true);
    setFailure(null);
    try {
      const result = await liveRequest("/cost-journals", journalResponseSchema, {
        method: "POST",
        body: { projectId, reason: reason.trim(), lines: body },
      });
      router.push(`/spending/journals/${result.journal.id}`);
    } catch (error) {
      setFailure(problem(error));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-4 rounded-xl border p-4"
      noValidate
    >
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      <p className="text-sm text-muted-foreground">{t("hint")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="journal-project">{t("project")}</FieldLabel>
          <select
            id="journal-project"
            className={spendingSelectClass}
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setLines((current) => current.map((line) => ({ ...line, tag: null })));
            }}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} · {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="journal-reason">{t("reason")}</FieldLabel>
          <Textarea
            id="journal-reason"
            rows={2}
            maxLength={REASON_LIMITS.max}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </div>
      <ol className="space-y-4">
        {lines.map((line, index) => (
          <li key={line.key} className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{t("line", { number: index + 1 })}</h3>
              {lines.length > 1 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setLines((current) => current.filter((entry) => entry.key !== line.key))
                  }
                >
                  <Trash2 aria-hidden /> {t("removeLine")}
                </Button>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor={`${line.key}-measure`}>{t("measure")}</FieldLabel>
                <select
                  id={`${line.key}-measure`}
                  className={spendingSelectClass}
                  value={line.measure}
                  onChange={(event) =>
                    update(line.key, { measure: event.target.value as CostMeasure })
                  }
                >
                  {COST_MEASURES.map((value) => (
                    <option key={value} value={value}>
                      {tMeasure(value)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${line.key}-category`}>{t("category")}</FieldLabel>
                <select
                  id={`${line.key}-category`}
                  className={spendingSelectClass}
                  value={line.category}
                  onChange={(event) =>
                    update(line.key, { category: event.target.value as CostCategory })
                  }
                >
                  {COST_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {tCategory(value)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${line.key}-date`}>{t("date")}</FieldLabel>
                <Input
                  id={`${line.key}-date`}
                  type="date"
                  value={line.occurredOn}
                  onChange={(event) => update(line.key, { occurredOn: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${line.key}-sign`}>{t("sign")}</FieldLabel>
                <select
                  id={`${line.key}-sign`}
                  className={spendingSelectClass}
                  value={line.sign}
                  onChange={(event) =>
                    update(line.key, {
                      sign: event.target.value === "decrease" ? "decrease" : "increase",
                    })
                  }
                >
                  <option value="increase">{t("increase")}</option>
                  <option value="decrease">{t("decrease")}</option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${line.key}-amount`}>{t("amount")}</FieldLabel>
                <Input
                  id={`${line.key}-amount`}
                  inputMode="decimal"
                  autoComplete="off"
                  value={line.amount}
                  onChange={(event) => update(line.key, { amount: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${line.key}-party`}>{t("counterparty")}</FieldLabel>
                <Input
                  id={`${line.key}-party`}
                  maxLength={200}
                  value={line.counterpartyName}
                  onChange={(event) => update(line.key, { counterpartyName: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${line.key}-reference`}>{t("reference")}</FieldLabel>
                <Input
                  id={`${line.key}-reference`}
                  maxLength={60}
                  value={line.paymentReference}
                  onChange={(event) => update(line.key, { paymentReference: event.target.value })}
                />
              </Field>
            </div>
            {projectId ? (
              <TagPicker
                id={`${line.key}-tag`}
                projectId={projectId}
                value={line.tag}
                onChange={(tag) =>
                  update(
                    line.key,
                    tag?.kind === "costCode" ? { tag, category: tag.category } : { tag },
                  )
                }
              />
            ) : null}
          </li>
        ))}
      </ol>
      {lines.length < SPENDING_LIMITS.journalLines ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setLines((current) => [...current, newLine(added + 1)]);
            setAdded(added + 1);
          }}
        >
          <Plus aria-hidden /> {t("addLine")}
        </Button>
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={busy || !projectId}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}
