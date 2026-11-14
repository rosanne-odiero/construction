"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Ruler } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import type { StandardUnitCode } from "@pm-buddy/types";
import {
  measurementResponseSchema,
  storeDetailResponseSchema,
  storesSettingsResponseSchema,
  type StockBalance,
  type StoresSettingsResponse,
  type StoresBqItem,
  type UnitWire,
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
import { unitLabel } from "@/lib/procurement";
import { formatStock, nonNegativeQuantity } from "@/lib/stores";

const PERCENT = /^\d{1,4}(?:\.\d{1,4})?$/;
const MEASURED = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/;

/** The consumption variance threshold (config.manage). Negative stock is never allowed. */
export function StoresSettingsForm({ settings }: { settings: StoresSettingsResponse }) {
  const t = useTranslations("stores.settings");
  const tCommon = useTranslations("stores.common");
  const problem = useP2pProblem();
  const router = useRouter();
  const [value, setValue] = useState(settings.settings.varianceThresholdPercent);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const trimmed = value.trim();
  const valid = PERCENT.test(trimmed) && Number(trimmed) <= 1000;

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await liveRequest("/stores/settings", storesSettingsResponseSchema, {
        method: "PUT",
        body: { version: settings.settings.version, varianceThresholdPercent: trimmed },
      });
      setMessage({ ok: true, text: t("saved") });
      router.refresh();
    } catch (error) {
      setMessage({ ok: false, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="max-w-md space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void save();
      }}
    >
      <Field>
        <FieldLabel htmlFor="variance-threshold">{t("threshold")}</FieldLabel>
        <Input
          id="variance-threshold"
          inputMode="decimal"
          className="h-11 text-base"
          value={value}
          disabled={!settings.permissions.canEdit}
          aria-invalid={!valid}
          onChange={(event) => setValue(event.target.value)}
        />
        <FieldDescription>{t("thresholdHint")}</FieldDescription>
      </Field>
      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "text-sm" : "text-sm text-destructive"}
        >
          {message.text}
        </p>
      ) : null}
      {settings.permissions.canEdit ? (
        <Button type="submit" className="h-11" disabled={busy || !valid}>
          {busy ? tCommon("saving") : tCommon("save")}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">{t("readOnly")}</p>
      )}
    </form>
  );
}

/** Reorder levels per material of a store (base unit); empty removes a level. */
export function ReorderLevelsForm({
  storeId,
  balances,
  units,
}: {
  storeId: string;
  balances: StockBalance[];
  units: UnitWire[];
}) {
  const t = useTranslations("stores.reorder");
  const tCommon = useTranslations("stores.common");
  const tUnits = useTranslations("catalogue.units");
  const problem = useP2pProblem();
  const router = useRouter();
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const [levels, setLevels] = useState<Record<string, string>>(() =>
    Object.fromEntries(balances.map((row) => [row.material.id, row.reorderLevel ?? ""])),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const rows = balances.map((row) => {
    const raw = (levels[row.material.id] ?? "").trim();
    return { row, raw, value: raw === "" ? null : nonNegativeQuantity(raw) };
  });
  const valid = rows.every((entry) => entry.raw === "" || entry.value !== null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await liveRequest(`/stores/${storeId}/reorder-levels`, storeDetailResponseSchema, {
        method: "PUT",
        body: {
          levels: rows.map((entry) => ({
            materialId: entry.row.material.id,
            reorderLevel: entry.raw === "" ? null : entry.value,
          })),
        },
      });
      setMessage({ ok: true, text: t("saved") });
      router.refresh();
    } catch (error) {
      setMessage({ ok: false, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }

  if (!balances.length) return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void save();
      }}
    >
      <ul className="space-y-2">
        {rows.map(({ row, raw, value }) => (
          <li key={row.material.id} className="rounded-lg border p-3">
            <Field>
              <FieldLabel htmlFor={`level-${row.material.id}`}>
                {row.material.name} ({label(row.material.baseUnit)})
              </FieldLabel>
              <Input
                id={`level-${row.material.id}`}
                inputMode="decimal"
                className="h-11 text-base"
                value={levels[row.material.id] ?? ""}
                aria-invalid={raw !== "" && value === null}
                onChange={(event) =>
                  setLevels((current) => ({ ...current, [row.material.id]: event.target.value }))
                }
              />
              <FieldDescription>
                {t("onHand", {
                  quantity: formatStock(row.quantity),
                  unit: label(row.material.baseUnit),
                })}
              </FieldDescription>
            </Field>
          </li>
        ))}
      </ul>
      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "text-sm" : "text-sm text-destructive"}
        >
          {message.text}
        </p>
      ) : null}
      <Button type="submit" className="h-11 w-full sm:w-auto" disabled={busy || !valid}>
        {busy ? tCommon("saving") : tCommon("save")}
      </Button>
    </form>
  );
}

/**
 * Records the quantity completed to date of a BQ item (minimal measurement; D6.3 adds approval
 * and photos). The variance report uses the latest measurement.
 */
export function MeasurementDialog({ projectId, item }: { projectId: string; item: StoresBqItem }) {
  const t = useTranslations("stores.measure");
  const tCommon = useTranslations("stores.common");
  const problem = useP2pProblem();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [measuredOn, setMeasuredOn] = useState(nairobiDate);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const trimmed = quantity.trim();
  const valid =
    MEASURED.test(trimmed) && /^\d{4}-\d{2}-\d{2}$/.test(measuredOn) && measuredOn <= nairobiDate();
  const id = `measure-${item.lineageId}`;

  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest(`/projects/${projectId}/measurements`, measurementResponseSchema, {
        method: "POST",
        body: {
          bqItemLineageId: item.lineageId,
          measuredOn,
          quantityToDate: trimmed,
          note: note.trim() || null,
        },
      });
      setOpen(false);
      setQuantity("");
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Ruler aria-hidden /> {t("button")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>
              {item.ref ? `${item.ref} · ` : ""}
              {item.description}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-quantity`}>
              {t("quantity", { unit: item.unit ?? "" })}
            </FieldLabel>
            <Input
              id={`${id}-quantity`}
              inputMode="decimal"
              className="h-11 text-base"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
            <FieldDescription>{t("quantityHint")}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-date`}>{t("date")}</FieldLabel>
            <Input
              id={`${id}-date`}
              type="date"
              className="h-11 text-base"
              max={nairobiDate()}
              value={measuredOn}
              onChange={(event) => setMeasuredOn(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-note`}>{tCommon("notes")}</FieldLabel>
            <Textarea
              id={`${id}-note`}
              rows={2}
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tCommon("close")}
            </Button>
            <Button type="button" disabled={busy || !valid} onClick={() => void save()}>
              {busy ? tCommon("saving") : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
