"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { COST_CATEGORIES, type CostCategory } from "@pm-buddy/types";
import { budgetDetailResponseSchema } from "@pm-buddy/validation";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { parseKesInput } from "@/lib/spending";
import { spendingSelectClass } from "./spending-action";
import { TagPicker, type CostTag } from "./tag-picker";

/**
 * Adds a budget line: a BQ item of the budget's BQ version (with an optional category) or a
 * company cost code (its category comes from the code). The API refuses a second line for the
 * same item or code.
 */
export function BudgetLineForm({
  budgetId,
  projectId,
  version,
}: {
  budgetId: string;
  projectId: string;
  version: number;
}) {
  const t = useTranslations("spending.budget.lineForm");
  const tCategory = useTranslations("spending.categories");
  const problem = useP2pProblem();
  const router = useRouter();
  const [tag, setTag] = useState<CostTag | null>(null);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<CostCategory | "">("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const amountMinor = parseKesInput(amount, true);
    if (!tag) return setFailure(t("tagRequired"));
    if (amountMinor === null) return setFailure(t("amountInvalid"));
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest(`/budgets/${budgetId}/lines`, budgetDetailResponseSchema, {
        method: "POST",
        body: {
          version,
          amountMinor,
          ...(tag.kind === "item"
            ? { bqItemLineageId: tag.lineageId, category: category || null }
            : { costCodeId: tag.id }),
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      });
      setTag(null);
      setAmount("");
      setDescription("");
      setCategory("");
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void add(event)}
      className="space-y-3 rounded-xl border p-4"
      noValidate
    >
      <h3 className="font-semibold">{t("title")}</h3>
      <TagPicker id="budget-line-tag" projectId={projectId} value={tag} onChange={setTag} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="budget-line-amount">{t("amount")}</FieldLabel>
          <Input
            id="budget-line-amount"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <FieldDescription>{t("amountHint")}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="budget-line-description">{t("description")}</FieldLabel>
          <Input
            id="budget-line-description"
            maxLength={300}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        {tag?.kind === "item" ? (
          <Field>
            <FieldLabel htmlFor="budget-line-category">{t("category")}</FieldLabel>
            <select
              id="budget-line-category"
              className={spendingSelectClass}
              value={category}
              onChange={(event) => setCategory(event.target.value as CostCategory | "")}
            >
              <option value="">{t("noCategory")}</option>
              {COST_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {tCategory(value)}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        {t("add")}
      </Button>
    </form>
  );
}
