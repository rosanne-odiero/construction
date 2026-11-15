"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import type { StandardUnitCode } from "@pm-buddy/types";
import {
  transferResponseSchema,
  type IssueOptionsResponse,
  type StoreRef,
  type TransferResponse,
  type UnitWire,
} from "@pm-buddy/validation";
import { selectClass } from "@/components/procurement/material-form";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { unitLabel } from "@/lib/procurement";
import {
  above,
  formatStock,
  newClientId,
  nonNegativeQuantity,
  positiveQuantity,
} from "@/lib/stores";

type Line = { key: string; materialId: string; quantity: string };

/**
 * Dispatch stock to another site's store (D5.3). The stock leaves this store at its average cost
 * and is in transit until the other store receives it. One ID and Idempotency-Key per form, so a
 * retry never sends the stock twice.
 */
export function TransferForm({
  options,
  targets,
  units,
}: {
  options: IssueOptionsResponse;
  targets: StoreRef[];
  units: UnitWire[];
}) {
  const t = useTranslations("stores.transferForm");
  const tCommon = useTranslations("stores.common");
  const tUnits = useTranslations("catalogue.units");
  const problem = useP2pProblem();
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const [identity] = useState(() => ({ id: newClientId(), key: newClientId() }));
  const capturedAt = useRef<string | null>(null);
  const sending = useRef(false);
  const [to, setTo] = useState(targets[0]?.id ?? "");
  const [lines, setLines] = useState<Line[]>(() => [
    { key: newClientId(), materialId: options.stock[0]?.material.id ?? "", quantity: "" },
  ]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<TransferResponse | null>(null);
  const stock = new Map(options.stock.map((entry) => [entry.material.id, entry]));
  const states = lines.map((line) => {
    const entry = stock.get(line.materialId);
    const quantity = positiveQuantity(line.quantity);
    return {
      entry,
      quantity,
      tooMuch: Boolean(entry && quantity && above(quantity, entry.quantity)),
    };
  });
  const unique = new Set(lines.map((line) => line.materialId)).size === lines.length;
  const valid =
    Boolean(to) &&
    unique &&
    states.every((state) => state.entry && state.quantity && !state.tooMuch);

  async function submit() {
    if (sending.current || !valid) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    capturedAt.current ??= new Date().toISOString();
    try {
      setResult(
        await liveRequest("/stock-transfers", transferResponseSchema, {
          method: "POST",
          headers: { "Idempotency-Key": identity.key },
          body: {
            id: identity.id,
            fromStoreId: options.store.id,
            toStoreId: to,
            capturedAt: capturedAt.current,
            notes: notes.trim() || null,
            source: "web",
            lines: lines.map((line, index) => ({
              materialId: line.materialId,
              quantity: states[index]!.quantity,
              unit: stock.get(line.materialId)!.material.baseUnit,
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

  if (!targets.length) return <p className="text-sm text-muted-foreground">{t("noTargets")}</p>;
  if (!options.stock.length) return <p className="text-sm text-muted-foreground">{t("noStock")}</p>;
  if (result)
    return (
      <section
        className="space-y-3 rounded-xl border p-4"
        aria-labelledby="transfer-result"
        role="status"
      >
        <h2 id="transfer-result" className="text-lg font-semibold">
          {result.replayed
            ? t("replayed", { number: result.transfer.number })
            : t("recorded", { number: result.transfer.number })}
        </h2>
        <Button asChild className="h-11">
          <Link href={`/stores/transfers/${result.transfer.id}`}>
            {t("open", { number: result.transfer.number })}
          </Link>
        </Button>
      </section>
    );

  return (
    <form
      className="space-y-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field>
        <FieldLabel htmlFor="transfer-to">{t("to")}</FieldLabel>
        <select
          id="transfer-to"
          className={`${selectClass} h-11`}
          value={to}
          onChange={(event) => setTo(event.target.value)}
        >
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.name} · {target.project.code}
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t("lines")}</legend>
        {lines.map((line, index) => {
          const state = states[index]!;
          const id = `transfer-line-${index + 1}`;
          const set = (patch: Partial<Line>) =>
            setLines((current) =>
              current.map((entry) => (entry.key === line.key ? { ...entry, ...patch } : entry)),
            );
          return (
            <div key={line.key} className="space-y-2 rounded-lg border p-3">
              <Field>
                <FieldLabel htmlFor={`${id}-material`}>{tCommon("material")}</FieldLabel>
                <select
                  id={`${id}-material`}
                  className={`${selectClass} h-11`}
                  value={line.materialId}
                  onChange={(event) => set({ materialId: event.target.value })}
                >
                  {options.stock.map((entry) => (
                    <option key={entry.material.id} value={entry.material.id}>
                      {entry.material.name}
                    </option>
                  ))}
                </select>
                {state.entry ? (
                  <FieldDescription>
                    {t("onHand", {
                      quantity: formatStock(state.entry.quantity),
                      unit: label(state.entry.material.baseUnit),
                    })}
                  </FieldDescription>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-quantity`}>
                  {t("quantityIn", {
                    unit: state.entry ? label(state.entry.material.baseUnit) : "",
                  })}
                </FieldLabel>
                <Input
                  id={`${id}-quantity`}
                  inputMode="decimal"
                  className="h-11 text-base"
                  value={line.quantity}
                  aria-invalid={line.quantity.trim() !== "" && (!state.quantity || state.tooMuch)}
                  onChange={(event) => set({ quantity: event.target.value })}
                />
              </Field>
              {state.tooMuch ? <p className="text-sm text-destructive">{t("tooMuch")}</p> : null}
              {lines.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11"
                  onClick={() =>
                    setLines((current) => current.filter((entry) => entry.key !== line.key))
                  }
                >
                  <Trash2 aria-hidden /> {t("removeLine")}
                </Button>
              ) : null}
            </div>
          );
        })}
        {lines.length < options.stock.length ? (
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full sm:w-auto"
            onClick={() =>
              setLines((current) => [
                ...current,
                {
                  key: newClientId(),
                  materialId:
                    options.stock.find(
                      (entry) => !current.some((line) => line.materialId === entry.material.id),
                    )?.material.id ?? "",
                  quantity: "",
                },
              ])
            }
          >
            <Plus aria-hidden /> {t("addLine")}
          </Button>
        ) : null}
      </fieldset>
      <Field>
        <FieldLabel htmlFor="transfer-notes">{tCommon("notes")}</FieldLabel>
        <Textarea
          id="transfer-notes"
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

/**
 * Record what arrived, per line, in the base unit (D5.3). Anything different from what was sent
 * needs a reason and makes the transfer disputed (the shortfall is a transit loss for review).
 * One Idempotency-Key per form: a retry after a lost response replays the receipt.
 */
export function ReceiveForm({
  transfer,
  units,
}: {
  transfer: TransferResponse;
  units: UnitWire[];
}) {
  const t = useTranslations("stores.receiveForm");
  const tCommon = useTranslations("stores.common");
  const tUnits = useTranslations("catalogue.units");
  const problem = useP2pProblem();
  const router = useRouter();
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const [key] = useState(newClientId);
  const capturedAt = useRef<string | null>(null);
  const sending = useRef(false);
  const lines = transfer.transfer.lines;
  const [received, setReceived] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((line) => [line.id, line.baseQuantity])),
  );
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const states = lines.map((line) => {
    const quantity = nonNegativeQuantity(received[line.id] ?? "");
    const differs =
      quantity !== null &&
      quantity !== "" &&
      (above(quantity, line.baseQuantity) || above(line.baseQuantity, quantity));
    return { line, quantity, differs, reason: (reasons[line.id] ?? "").trim() };
  });
  const valid = states.every(
    (state) => state.quantity !== null && (!state.differs || state.reason.length >= 3),
  );

  async function submit() {
    if (sending.current || !valid) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    capturedAt.current ??= new Date().toISOString();
    try {
      await liveRequest(
        `/stock-transfers/${transfer.transfer.id}/receive`,
        transferResponseSchema,
        {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: {
            capturedAt: capturedAt.current,
            lines: states.map((state) => ({
              lineId: state.line.id,
              receivedQuantity: state.quantity,
              differenceReason: state.differs ? state.reason : null,
            })),
          },
        },
      );
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      noValidate
      aria-labelledby="receive-title"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 id="receive-title" className="text-lg font-semibold">
        {t("title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      {states.map((state) => {
        const id = `receive-line-${state.line.lineNo}`;
        return (
          <div key={state.line.id} className="space-y-2 rounded-lg border p-3">
            <Field>
              <FieldLabel htmlFor={id}>
                {state.line.material.name} ({label(state.line.material.baseUnit)})
              </FieldLabel>
              <Input
                id={id}
                inputMode="decimal"
                className="h-11 text-base"
                value={received[state.line.id] ?? ""}
                aria-invalid={state.quantity === null}
                onChange={(event) =>
                  setReceived((current) => ({ ...current, [state.line.id]: event.target.value }))
                }
              />
              <FieldDescription>
                {t("sent", {
                  quantity: formatStock(state.line.baseQuantity),
                  unit: label(state.line.material.baseUnit),
                })}
              </FieldDescription>
            </Field>
            {state.differs ? (
              <Field>
                <FieldLabel htmlFor={`${id}-reason`}>{t("differenceReason")}</FieldLabel>
                <Input
                  id={`${id}-reason`}
                  className="h-11 text-base"
                  maxLength={300}
                  value={reasons[state.line.id] ?? ""}
                  onChange={(event) =>
                    setReasons((current) => ({ ...current, [state.line.id]: event.target.value }))
                  }
                />
                <FieldDescription>{t("differenceHint")}</FieldDescription>
              </Field>
            ) : null}
          </div>
        );
      })}
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
