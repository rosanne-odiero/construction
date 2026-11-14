"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { WASTAGE_REASONS, type StandardUnitCode, type WastageReason } from "@pm-buddy/types";
import {
  movementResponseSchema,
  type IssueOptionsResponse,
  type MovementResponse,
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
import { above, formatStock, newClientId, positiveQuantity } from "@/lib/stores";

type Line = { key: string; materialId: string; quantity: string };
const blankLine = (materialId = ""): Line => ({ key: newClientId(), materialId, quantity: "" });

/**
 * Mobile-first issue or wastage form (D5.3). Quantities are typed in each material's base unit
 * and checked against what is on hand (the API checks again under the stock lock: stock never
 * goes negative). The record's ID, its Idempotency-Key and the capture time are created once per
 * form, so a double tap or a retry after a lost response replays the same movement instead of
 * issuing twice. Typed numbers are trimmed and validated without ever throwing during render.
 */
export function MovementForm({
  kind,
  options,
  units,
}: {
  kind: "issue" | "wastage";
  options: IssueOptionsResponse;
  units: UnitWire[];
}) {
  const t = useTranslations("stores.movementForm");
  const tCommon = useTranslations("stores.common");
  const tStatus = useTranslations("stores.status");
  const tUnits = useTranslations("catalogue.units");
  const problem = useP2pProblem();
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const [identity, setIdentity] = useState(() => ({ id: newClientId(), key: newClientId() }));
  const capturedAt = useRef<string | null>(null);
  const sending = useRef(false);
  const [bqItem, setBqItem] = useState("");
  const [filter, setFilter] = useState("");
  const [gang, setGang] = useState("");
  const [issuedTo, setIssuedTo] = useState("");
  const [reason, setReason] = useState<WastageReason>("damaged");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [blankLine(options.stock[0]?.material.id)]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<MovementResponse | null>(null);

  const stock = new Map(options.stock.map((entry) => [entry.material.id, entry]));
  const needle = filter.trim().toLowerCase();
  const items = options.bqItems.filter(
    (item) =>
      !needle ||
      item.lineageId === bqItem ||
      item.description.toLowerCase().includes(needle) ||
      (item.ref ?? "").toLowerCase().includes(needle),
  );
  const lineState = lines.map((line) => {
    const entry = stock.get(line.materialId);
    const quantity = positiveQuantity(line.quantity);
    const tooMuch = Boolean(entry && quantity && above(quantity, entry.quantity));
    return { entry, quantity, tooMuch, typed: line.quantity.trim() !== "" };
  });
  const materials = lines.map((line) => line.materialId);
  const duplicate = new Set(materials).size !== materials.length;
  const targetOk = kind === "wastage" || Boolean(bqItem || gang);
  const valid =
    lines.length > 0 &&
    !duplicate &&
    lineState.every((state) => state.entry && state.quantity && !state.tooMuch) &&
    targetOk &&
    (kind === "wastage" ? notes.trim().length >= 3 : issuedTo.trim().length >= 2);

  async function submit() {
    if (sending.current || !valid) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    capturedAt.current ??= new Date().toISOString();
    const body = {
      id: identity.id,
      storeId: options.store.id,
      capturedAt: capturedAt.current,
      notes: notes.trim() || null,
      source: "web",
      lines: lines.map((line, index) => ({
        materialId: line.materialId,
        quantity: lineState[index]!.quantity,
        unit: stock.get(line.materialId)!.material.baseUnit,
      })),
      ...(kind === "issue"
        ? { bqItemLineageId: bqItem || null, gangId: gang || null, issuedToName: issuedTo.trim() }
        : { reason, notes: notes.trim() }),
    };
    try {
      setResult(
        await liveRequest(
          kind === "issue" ? "/stock-movements/issues" : "/stock-movements/wastage",
          movementResponseSchema,
          { method: "POST", headers: { "Idempotency-Key": identity.key }, body },
        ),
      );
    } catch (error) {
      setFailure(problem(error));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function reset() {
    setIdentity({ id: newClientId(), key: newClientId() });
    capturedAt.current = null;
    setResult(null);
    setLines([blankLine(options.stock[0]?.material.id)]);
    setNotes("");
  }

  if (!options.stock.length) return <p className="text-sm text-muted-foreground">{t("noStock")}</p>;

  if (result) {
    const { movement } = result;
    return (
      <section
        aria-labelledby="movement-result"
        role="status"
        className="space-y-3 rounded-xl border p-4"
      >
        <h2 id="movement-result" className="text-lg font-semibold">
          {result.replayed
            ? t("replayed", { number: movement.number })
            : t("recorded", { number: movement.number })}
        </h2>
        <ul className="space-y-1 text-sm">
          {movement.lines.map((line) => (
            <li key={line.id}>
              {line.material.name}: {formatStock(line.baseQuantity)} {label(line.material.baseUnit)}
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild className="h-11">
            <Link href={`/stores/movements/${movement.id}`}>
              {t("open", { number: movement.number })}
            </Link>
          </Button>
          <Button type="button" variant="outline" className="h-11" onClick={reset}>
            {t("another")}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <form
      className="space-y-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {kind === "issue" ? (
        <>
          <Field>
            <FieldLabel htmlFor="issue-bq-filter">{t("findItem")}</FieldLabel>
            <Input
              id="issue-bq-filter"
              className="h-11 text-base"
              value={filter}
              placeholder={t("findItemPlaceholder")}
              onChange={(event) => setFilter(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="issue-bq-item">{t("bqItem")}</FieldLabel>
            <select
              id="issue-bq-item"
              className={`${selectClass} h-11 max-w-full`}
              value={bqItem}
              onChange={(event) => setBqItem(event.target.value)}
            >
              <option value="">{t("noBqItem")}</option>
              {items.map((item) => (
                <option key={item.lineageId} value={item.lineageId}>
                  {item.ref ? `${item.ref} · ` : ""}
                  {item.description.length > 60
                    ? `${Array.from(item.description).slice(0, 60).join("")}…`
                    : item.description}
                  {item.unit ? ` (${item.unit})` : ""}
                </option>
              ))}
            </select>
            <FieldDescription>
              {options.bqItems.length ? t("bqItemHint") : t("noApprovedBq")}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="issue-gang">{t("gang")}</FieldLabel>
            <select
              id="issue-gang"
              className={`${selectClass} h-11`}
              value={gang}
              onChange={(event) => setGang(event.target.value)}
            >
              <option value="">{t("noGang")}</option>
              {options.gangs.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </Field>
          {!targetOk ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t("targetRequired")}
            </p>
          ) : null}
          <Field>
            <FieldLabel htmlFor="issue-to">{t("issuedTo")}</FieldLabel>
            <Input
              id="issue-to"
              className="h-11 text-base"
              maxLength={100}
              value={issuedTo}
              onChange={(event) => setIssuedTo(event.target.value)}
            />
          </Field>
        </>
      ) : (
        <Field>
          <FieldLabel htmlFor="wastage-reason">{t("reason")}</FieldLabel>
          <select
            id="wastage-reason"
            className={`${selectClass} h-11`}
            value={reason}
            onChange={(event) => setReason(event.target.value as WastageReason)}
          >
            {WASTAGE_REASONS.map((entry) => (
              <option key={entry} value={entry}>
                {tStatus(`wastageReason.${entry}`)}
              </option>
            ))}
          </select>
        </Field>
      )}

      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t("lines")}</legend>
        {lines.map((line, index) => {
          const state = lineState[index]!;
          const id = `movement-line-${index + 1}`;
          const set = (patch: Partial<Line>) =>
            setLines((current) =>
              current.map((entry) => (entry.key === line.key ? { ...entry, ...patch } : entry)),
            );
          return (
            <div
              key={line.key}
              className="space-y-2 rounded-lg border p-3"
              role="group"
              aria-label={t("lineLabel", { number: index + 1 })}
            >
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
                  aria-invalid={state.typed && (!state.quantity || state.tooMuch)}
                  onChange={(event) => set({ quantity: event.target.value })}
                />
              </Field>
              {state.typed && !state.quantity ? (
                <p className="text-sm text-destructive">{t("invalidQuantity")}</p>
              ) : null}
              {state.tooMuch ? (
                <p className="text-sm text-destructive" role="status">
                  {t("tooMuch")}
                </p>
              ) : null}
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
        {duplicate ? <p className="text-sm text-destructive">{t("duplicate")}</p> : null}
        {lines.length < options.stock.length ? (
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full sm:w-auto"
            onClick={() =>
              setLines((current) => [
                ...current,
                blankLine(
                  options.stock.find(
                    (entry) => !current.some((line) => line.materialId === entry.material.id),
                  )?.material.id,
                ),
              ])
            }
          >
            <Plus aria-hidden /> {t("addLine")}
          </Button>
        ) : null}
      </fieldset>

      <Field>
        <FieldLabel htmlFor="movement-notes">
          {kind === "wastage" ? t("whatHappened") : tCommon("notes")}
        </FieldLabel>
        <Textarea
          id="movement-notes"
          rows={3}
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
        {busy ? tCommon("saving") : kind === "issue" ? t("submitIssue") : t("submitWastage")}
      </Button>
    </form>
  );
}
