"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { StandardUnitCode } from "@pm-buddy/types";
import { movementResponseSchema, type MovementResponse, type UnitWire } from "@pm-buddy/validation";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { unitLabel } from "@/lib/procurement";
import { above, formatStock, newClientId, positiveQuantity } from "@/lib/stores";

/**
 * A return of issued material to its store (D5.3): per issue line, never more than is still
 * outstanding (the API checks again under the issue's lock). Offline-ready like issues: one ID
 * and Idempotency-Key per form.
 */
export function ReturnForm({ issue, units }: { issue: MovementResponse; units: UnitWire[] }) {
  const t = useTranslations("stores.returnForm");
  const tCommon = useTranslations("stores.common");
  const tUnits = useTranslations("catalogue.units");
  const problem = useP2pProblem();
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const [identity, setIdentity] = useState(() => ({ id: newClientId(), key: newClientId() }));
  const capturedAt = useRef<string | null>(null);
  const sending = useRef(false);
  const returnable = issue.movement.lines.filter((line) =>
    /[1-9]/.test(line.returnableBaseQuantity ?? "0"),
  );
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<MovementResponse | null>(null);

  const typed = returnable
    .map((line) => ({ line, raw: quantities[line.id] ?? "" }))
    .filter((entry) => entry.raw.trim() !== "");
  const states = typed.map((entry) => {
    const quantity = positiveQuantity(entry.raw);
    return {
      ...entry,
      quantity,
      tooMuch: Boolean(quantity && above(quantity, entry.line.returnableBaseQuantity ?? "0")),
    };
  });
  const valid = states.length > 0 && states.every((state) => state.quantity && !state.tooMuch);

  async function submit() {
    if (sending.current || !valid) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    capturedAt.current ??= new Date().toISOString();
    try {
      setResult(
        await liveRequest("/stock-movements/returns", movementResponseSchema, {
          method: "POST",
          headers: { "Idempotency-Key": identity.key },
          body: {
            id: identity.id,
            issueId: issue.movement.id,
            capturedAt: capturedAt.current,
            notes: notes.trim() || null,
            source: "web",
            lines: states.map((state) => ({
              issueLineId: state.line.id,
              quantity: state.quantity,
              unit: state.line.material.baseUnit,
            })),
          },
        }),
      );
    } catch (error) {
      setFailure(problem(error));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  if (result)
    return (
      <section
        className="space-y-3 rounded-xl border p-4"
        aria-labelledby="return-result"
        role="status"
      >
        <h2 id="return-result" className="text-lg font-semibold">
          {result.replayed
            ? t("replayed", { number: result.movement.number })
            : t("recorded", { number: result.movement.number })}
        </h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild className="h-11">
            <Link href={`/stores/movements/${issue.movement.id}`}>
              {t("backToIssue", { number: issue.movement.number })}
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => {
              setIdentity({ id: newClientId(), key: newClientId() });
              capturedAt.current = null;
              setQuantities({});
              setResult(null);
            }}
          >
            {t("another")}
          </Button>
        </div>
      </section>
    );

  if (!returnable.length) return <p className="text-sm text-muted-foreground">{t("nothing")}</p>;

  return (
    <form
      className="space-y-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t("lines")}</legend>
        {returnable.map((line) => {
          const raw = quantities[line.id] ?? "";
          const state = states.find((entry) => entry.line.id === line.id);
          const id = `return-line-${line.lineNo}`;
          return (
            <div key={line.id} className="space-y-2 rounded-lg border p-3">
              <Field>
                <FieldLabel htmlFor={id}>
                  {line.material.name} ({label(line.material.baseUnit)})
                </FieldLabel>
                <Input
                  id={id}
                  inputMode="decimal"
                  className="h-11 text-base"
                  value={raw}
                  aria-invalid={Boolean(state && (!state.quantity || state.tooMuch))}
                  onChange={(event) =>
                    setQuantities((current) => ({ ...current, [line.id]: event.target.value }))
                  }
                />
                <FieldDescription>
                  {t("returnable", {
                    quantity: formatStock(line.returnableBaseQuantity ?? "0"),
                    unit: label(line.material.baseUnit),
                  })}
                </FieldDescription>
              </Field>
              {state && !state.quantity ? (
                <p className="text-sm text-destructive">{t("invalidQuantity")}</p>
              ) : null}
              {state?.tooMuch ? (
                <p className="text-sm text-destructive" role="status">
                  {t("tooMuch")}
                </p>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <Field>
        <FieldLabel htmlFor="return-notes">{tCommon("notes")}</FieldLabel>
        <Textarea
          id="return-notes"
          rows={2}
          maxLength={1000}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </Field>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <Button type="submit" className="h-11 w-full sm:w-auto" disabled={busy || !valid}>
        {busy ? tCommon("saving") : t("submit")}
      </Button>
    </form>
  );
}
