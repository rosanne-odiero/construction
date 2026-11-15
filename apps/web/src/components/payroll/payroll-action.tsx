"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";
import * as schemas from "@pm-buddy/validation";
import { ActionDialog, selectClass } from "@/components/labour/action-dialog";
import { useStepUp } from "@/components/projects/step-up";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { payrollCommand, kesInputToMinor } from "@/lib/payroll";
import { WorkerPicker } from "./worker-picker";

export type PayrollField = {
  name: string;
  label: string;
  type?:
    "text" | "date" | "number" | "money" | "textarea" | "json" | "select" | "worker" | "boolean";
  projectId?: string;
  value?: string;
  nullable?: boolean;
  options?: { value: string; label: string }[];
};

const commandSchemas = {
  empty: z.object({}).strict(),
  createBatchRequestSchema: schemas.createBatchRequestSchema,
  batchActionRequestSchema: schemas.batchActionRequestSchema,
  cancelBatchRequestSchema: schemas.cancelBatchRequestSchema,
  batchDetailResponseSchema: schemas.batchDetailResponseSchema,
  createStatutoryRuleRequestSchema: schemas.createStatutoryRuleRequestSchema,
  statutoryRuleResponseSchema: schemas.statutoryRuleResponseSchema,
  verifyStatutoryRuleRequestSchema: schemas.verifyStatutoryRuleRequestSchema,
  payrollRulesResponseSchema: schemas.payrollRulesResponseSchema,
  createMinimumWageRequestSchema: schemas.createMinimumWageRequestSchema,
  minimumWageResponseSchema: schemas.minimumWageResponseSchema,
  updatePayrollSettingsRequestSchema: schemas.updatePayrollSettingsRequestSchema,
  payrollSettingsResponseSchema: schemas.payrollSettingsResponseSchema,
  updatePayCalendarRequestSchema: schemas.updatePayCalendarRequestSchema,
  payCalendarResponseSchema: schemas.payCalendarResponseSchema,
  createAdvanceRequestSchema: schemas.createAdvanceRequestSchema,
  advanceResponseSchema: schemas.advanceResponseSchema,
  approveAdvanceRequestSchema: schemas.approveAdvanceRequestSchema,
  rejectAdvanceRequestSchema: schemas.rejectAdvanceRequestSchema,
  disburseAdvanceRequestSchema: schemas.disburseAdvanceRequestSchema,
  cancelAdvanceRequestSchema: schemas.cancelAdvanceRequestSchema,
  createAllowanceRequestSchema: schemas.createAllowanceRequestSchema,
  allowanceResponseSchema: schemas.allowanceResponseSchema,
  endAllowanceRequestSchema: schemas.endAllowanceRequestSchema,
  createOutputRequestSchema: schemas.createOutputRequestSchema,
  outputResponseSchema: schemas.outputResponseSchema,
  approveOutputRequestSchema: schemas.approveOutputRequestSchema,
  rejectOutputRequestSchema: schemas.rejectOutputRequestSchema,
} satisfies Record<string, z.ZodType<Record<string, unknown>>>;
type SchemaName = keyof typeof commandSchemas;

/** Shared command form: schema validation, expected versions, one retry key and explicit errors. */
export function PayrollAction({
  label,
  path,
  request,
  response,
  body = {},
  fields = [],
  method = "POST",
  destination,
  disabled,
}: {
  label: string;
  path: string;
  request: SchemaName;
  response: SchemaName;
  body?: Record<string, unknown>;
  fields?: PayrollField[];
  method?: "POST" | "PUT" | "DELETE";
  destination?: string | "batch";
  disabled?: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const t = useTranslations("payrollLive");
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const key = useRef("");
  const requestSchema: z.ZodType<Record<string, unknown>> = commandSchemas[request];
  const responseSchema: z.ZodType<Record<string, unknown>> = commandSchemas[response];
  const payload: Record<string, unknown> = { ...body };
  let validJson = true;
  for (const field of fields) {
    const value = values[field.name] ?? field.value ?? "";
    if (field.nullable && value === "") payload[field.name] = null;
    else if (field.type === "money") payload[field.name] = kesInputToMinor(value);
    else if (field.type === "number") payload[field.name] = value === "" ? null : Number(value);
    else if (field.type === "boolean") payload[field.name] = value === "true";
    else if (field.type === "json") {
      try {
        payload[field.name] = JSON.parse(value) as unknown;
      } catch {
        validJson = false;
      }
    } else payload[field.name] = value;
  }
  const parsed = requestSchema.safeParse(payload);
  return (
    <>
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setValues({});
          key.current = crypto.randomUUID();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <ActionDialog
        id={id}
        open={open}
        onOpenChange={setOpen}
        title={label}
        problemContext="payroll"
        description={t("confirmHint")}
        submitLabel={t("confirm")}
        submitDisabled={!validJson || !parsed.success}
        onSubmit={async () => {
          const result = await stepUp.run(() =>
            payrollCommand(path, responseSchema, requestSchema.parse(payload), method, key.current),
          );
          if (destination === "batch") {
            const batch = schemas.batchDetailResponseSchema.parse(result);
            router.push(`/payroll/batches/${batch.batch.id}`);
          } else if (destination) router.push(destination);
          router.refresh();
        }}
      >
        {fields.map((field) => {
          const inputId = `${id}-${field.name}`;
          const props = {
            id: inputId,
            value: values[field.name] ?? field.value ?? "",
            onChange: (
              event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
            ) => {
              key.current = crypto.randomUUID();
              setValues({ ...values, [field.name]: event.target.value });
            },
          };
          return (
            <Field key={field.name}>
              <FieldLabel htmlFor={inputId}>{field.label}</FieldLabel>
              {field.type === "worker" && field.projectId ? (
                <WorkerPicker
                  id={inputId}
                  projectId={field.projectId}
                  value={props.value}
                  onChange={(value) => {
                    key.current = crypto.randomUUID();
                    setValues({ ...values, [field.name]: value });
                  }}
                />
              ) : field.type === "boolean" ? (
                <select {...props} className={selectClass}>
                  <option value="true">{t("yes")}</option>
                  <option value="false">{t("no")}</option>
                </select>
              ) : field.type === "select" ? (
                <select {...props} className={selectClass}>
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.type === "textarea" || field.type === "json" ? (
                <Textarea {...props} rows={field.type === "json" ? 10 : 3} />
              ) : (
                <Input
                  {...props}
                  type={field.type === "date" || field.type === "number" ? field.type : "text"}
                  inputMode={field.type === "money" ? "decimal" : undefined}
                />
              )}
            </Field>
          );
        })}
        {fields.length > 0 && (!validJson || !parsed.success) ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("invalidForm")}
          </p>
        ) : null}
      </ActionDialog>
      {stepUp.dialog}
    </>
  );
}
