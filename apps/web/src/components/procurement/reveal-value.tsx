"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Eye, EyeOff } from "lucide-react";
import type { SupplierRevealField } from "@pm-buddy/types";
import { supplierRevealResponseSchema } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { liveRequest } from "@/lib/live-api";

/**
 * Shows a masked identifier and, for permitted users, reveals the full value on request. Each
 * reveal is a separate audited API call; the value is kept only in this component's state.
 */
export function RevealValue({
  supplierId,
  field,
  masked,
  contactId,
  payoutId,
  canReveal,
}: {
  supplierId: string;
  field: SupplierRevealField;
  masked: string;
  contactId?: string;
  payoutId?: string;
  canReveal: boolean;
}) {
  const t = useTranslations("suppliers.profile");
  const problem = useProblemMessage();
  const [value, setValue] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reveal() {
    setBusy(true);
    setFailure(null);
    try {
      const result = await liveRequest(
        `/suppliers/${supplierId}/reveal`,
        supplierRevealResponseSchema,
        {
          method: "POST",
          body: { field, ...(contactId ? { contactId } : {}), ...(payoutId ? { payoutId } : {}) },
        },
      );
      setValue(result.value);
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono tabular-nums" data-testid={`value-${field}`}>
        {value ?? masked}
      </span>
      {canReveal ? (
        value ? (
          <Button size="sm" variant="ghost" onClick={() => setValue(null)}>
            <EyeOff aria-hidden /> {t("hide")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={t("revealLabel", { field: t(`fields.${field}`) })}
            onClick={() => void reveal()}
          >
            <Eye aria-hidden /> {t("reveal")}
          </Button>
        )
      ) : null}
      {failure ? (
        <span role="alert" className="text-xs text-destructive">
          {failure}
        </span>
      ) : null}
    </span>
  );
}
