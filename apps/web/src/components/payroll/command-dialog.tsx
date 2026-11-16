"use client";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ActionDialog } from "@/components/labour/action-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

/**
 * One Idempotency-Key per prepared command: kept for the automatic retry after a step-up (or a
 * lost response), renewed when the dialog opens again or its input changes.
 */
export function useCommandKey() {
  const key = useRef("");
  return {
    renew: () => {
      key.current = crypto.randomUUID();
    },
    value: () => (key.current ||= crypto.randomUUID()),
  };
}

/** A button that opens a confirmation form; the API's refusal is shown inside it. */
export function CommandDialog({
  label,
  title,
  description,
  submitLabel,
  destructive,
  variant = "outline",
  size,
  disabled,
  submitDisabled,
  problem,
  onOpen,
  onSubmit,
  children,
}: {
  label: React.ReactNode;
  title: string;
  description?: string;
  submitLabel: string;
  destructive?: boolean;
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost";
  size?: "default" | "sm" | "xs";
  disabled?: boolean;
  submitDisabled?: boolean;
  problem?: (error: unknown) => string;
  onOpen?: () => void;
  onSubmit: () => Promise<void>;
  children?: React.ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={disabled}
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <ActionDialog
        id={id}
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        submitLabel={submitLabel}
        submitDisabled={submitDisabled}
        destructive={destructive}
        problem={problem}
        onSubmit={onSubmit}
      >
        {children}
      </ActionDialog>
    </>
  );
}

/** A required reason (10–500 characters), as every D4.3 decision and release asks for. */
export function ReasonField({
  value,
  onChange,
  label,
  optional = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  optional?: boolean;
}) {
  const t = useTranslations("payouts.common");
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label ?? t(optional ? "noteOptional" : "reason")}</FieldLabel>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        minLength={optional ? undefined : 10}
        maxLength={500}
        rows={3}
        required={!optional}
        aria-describedby={`${id}-hint`}
      />
      <FieldDescription id={`${id}-hint`}>
        {t(optional ? "noteHint" : "reasonHint")}
      </FieldDescription>
    </Field>
  );
}

/** A reason is 10–500 characters after trimming (shared payroll rule). */
export const validReason = (value: string) =>
  value.trim().length >= 10 && value.trim().length <= 500;
