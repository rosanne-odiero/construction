"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { REASON_LIMITS } from "@pm-buddy/domain";
import {
  budgetDetailResponseSchema,
  cashFlowItemResponseSchema,
  costCodeResponseSchema,
  countResponseSchema,
  expenseResponseSchema,
  floatResponseSchema,
  journalResponseSchema,
  loadCostCodeDefaultsResponseSchema,
  topUpResponseSchema,
} from "@pm-buddy/validation";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { parseKesInput } from "@/lib/spending";

export type ActionText = { button: string; title: string; description: string; confirm: string };

/** An input the command needs; `money` is typed in KES and sent as minor units. */
export type ActionField =
  | { kind: "reason"; name?: string; label?: string }
  | { kind: "text"; name: string; label: string; optional?: boolean; maxLength?: number }
  | { kind: "date"; name: string; label: string; defaultValue: string }
  | { kind: "money"; name: string; label: string; allowZero?: boolean; defaultValue?: string }
  | {
      kind: "select";
      name: string;
      label: string;
      options: { value: string; label: string }[];
      defaultValue?: string;
    };

/** What a command returns, and the page that shows a record it created. */
const ENTITIES = {
  budget: {
    schema: budgetDetailResponseSchema,
    href: (result: { budget: { id: string } }) => `/spending/budgets/${result.budget.id}`,
  },
  float: {
    schema: floatResponseSchema,
    href: (result: { float: { id: string } }) => `/spending/petty-cash/${result.float.id}`,
  },
  expense: {
    schema: expenseResponseSchema,
    href: (result: { expense: { id: string } }) =>
      `/spending/petty-cash/expenses/${result.expense.id}`,
  },
  topUp: { schema: topUpResponseSchema, href: null },
  count: { schema: countResponseSchema, href: null },
  journal: {
    schema: journalResponseSchema,
    href: (result: { journal: { id: string } }) => `/spending/journals/${result.journal.id}`,
  },
  cashFlowItem: { schema: cashFlowItemResponseSchema, href: null },
  costCode: { schema: costCodeResponseSchema, href: null },
  costCodeDefaults: { schema: loadCostCodeDefaultsResponseSchema, href: null },
} as const;
export type SpendingEntity = keyof typeof ENTITIES;

export const spendingSelectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

const fieldName = (field: ActionField) => field.name ?? "reason";

/**
 * One spending command behind a confirmation dialog, with the inputs the workflow needs. The API
 * decides: refusals such as maker-checker, a float without enough cash or a stale budget are shown
 * in the dialog in EN/SW. On success the page refreshes, or opens the created record
 * (`openResult`). Props are serialisable: server pages render this client component.
 */
export function SpendingAction({
  path,
  entity,
  body = {},
  fields = [],
  text,
  primary = false,
  destructive = false,
  method = "POST",
  openResult = false,
}: {
  path: string;
  entity: SpendingEntity;
  body?: Record<string, unknown>;
  fields?: ActionField[];
  text: ActionText;
  primary?: boolean;
  destructive?: boolean;
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  openResult?: boolean;
}) {
  const t = useTranslations("spending.common");
  const problem = useP2pProblem();
  const router = useRouter();
  const initial = () =>
    Object.fromEntries(
      fields.map((field) => [
        fieldName(field),
        "defaultValue" in field && field.defaultValue !== undefined
          ? field.defaultValue
          : field.kind === "select"
            ? (field.options[0]?.value ?? "")
            : "",
      ]),
    );
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const id = `action-${path.replace(/[^a-z0-9]/gi, "-")}-${method.toLowerCase()}`;

  /** The request body, or the first invalid field's message. */
  function build(): { body: Record<string, unknown> } | { invalid: string } {
    const result: Record<string, unknown> = { ...body };
    for (const field of fields) {
      const name = fieldName(field);
      const raw = values[name] ?? "";
      if (field.kind === "reason") {
        if (Array.from(raw.trim()).length < REASON_LIMITS.min) return { invalid: t("reasonShort") };
        result[name] = raw.trim();
      } else if (field.kind === "money") {
        const minor = parseKesInput(raw, field.allowZero);
        if (minor === null) return { invalid: t("amountInvalid", { field: field.label }) };
        result[name] = minor;
      } else if (field.kind === "text") {
        const trimmed = raw.trim();
        if (!trimmed && !field.optional) return { invalid: t("required", { field: field.label }) };
        if (trimmed) result[name] = trimmed;
      } else {
        if (!raw) return { invalid: t("required", { field: field.label }) };
        result[name] = raw;
      }
    }
    return { body: result };
  }

  async function run() {
    const built = build();
    if ("invalid" in built) {
      setFailure(built.invalid);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const target = ENTITIES[entity];
      const result = await liveRequest(path, target.schema as z.ZodType<unknown>, {
        method,
        ...(method === "DELETE" ? {} : { body: built.body }),
      });
      setOpen(false);
      if (openResult && target.href)
        router.push((target.href as (value: unknown) => string)(result));
      else router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={primary ? "default" : "outline"}
        onClick={() => {
          setFailure(null);
          setValues(initial());
          setOpen(true);
        }}
      >
        {text.button}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{text.title}</DialogTitle>
            <DialogDescription>{text.description}</DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          {fields.map((field) => {
            const name = fieldName(field);
            const inputId = `${id}-${name}`;
            const value = values[name] ?? "";
            const set = (next: string) => setValues((current) => ({ ...current, [name]: next }));
            if (field.kind === "reason")
              return (
                <Field key={name}>
                  <FieldLabel htmlFor={inputId}>{field.label ?? t("reason")}</FieldLabel>
                  <Textarea
                    id={inputId}
                    value={value}
                    onChange={(event) => set(event.target.value)}
                    maxLength={REASON_LIMITS.max}
                    rows={3}
                    required
                  />
                  <FieldDescription>{t("reasonHint")}</FieldDescription>
                </Field>
              );
            if (field.kind === "select")
              return (
                <Field key={name}>
                  <FieldLabel htmlFor={inputId}>{field.label}</FieldLabel>
                  <select
                    id={inputId}
                    className={spendingSelectClass}
                    value={value}
                    onChange={(event) => set(event.target.value)}
                  >
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>
              );
            return (
              <Field key={name}>
                <FieldLabel htmlFor={inputId}>
                  {field.kind === "text" && field.optional
                    ? t("optionalLabel", { label: field.label })
                    : field.label}
                </FieldLabel>
                <Input
                  id={inputId}
                  type={field.kind === "date" ? "date" : "text"}
                  inputMode={field.kind === "money" ? "decimal" : undefined}
                  autoComplete="off"
                  maxLength={field.kind === "text" ? (field.maxLength ?? 200) : undefined}
                  value={value}
                  onChange={(event) => set(event.target.value)}
                />
                {field.kind === "money" ? (
                  <FieldDescription>{t("amountHint")}</FieldDescription>
                ) : null}
              </Field>
            );
          })}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("close")}
            </Button>
            <Button
              type="button"
              variant={destructive ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void run()}
            >
              {text.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
