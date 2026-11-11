"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2, Minus, Pencil, Plus, Save, Trash2, Undo2 } from "lucide-react";
import {
  BQ_UNITS,
  VARIATION_ADD_KINDS,
  type BqUnit,
  type VariationAddKind,
  type VariationLineIssue,
} from "@pm-buddy/types";
import {
  bqBillResponseSchema,
  variationResponseSchema,
  type BqBillResponse,
  type BqBillWire,
  type BqItemWire,
  type VariationDetail,
  type VariationLineInputWire,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { decimalKesToMinor, formatDecimalString, formatKES } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { useUnitLabel } from "./bq-labels";
import { VariationActions } from "./variation-actions";

const DECIMAL = /^\d{1,12}(\.\d{1,4})?$/;
const KES = /^\d{1,12}(\.\d{1,2})?$/;

type Target = {
  billNumber: string;
  billTitle: string;
  sectionTitle: string | null;
  ref: string | null;
  description: string | null;
  unit: BqUnit | null;
  unitRaw: string | null;
  quantity: string | null;
  rate: string | null;
  amountMinor: number | null;
};
type Row = {
  key: string;
  input: VariationLineInputWire;
  target: Target;
  /** The server's pricing, while the line is unchanged since the last save. */
  priced: { baseAmountMinor: number; newAmountMinor: number; deltaMinor: number } | null;
  issue: VariationLineIssue | null;
};

function rowsOf(variation: VariationDetail): Row[] {
  return variation.lines.map((line) => {
    let input: VariationLineInputWire;
    if (line.action === "add")
      input = {
        id: line.id,
        action: "add",
        billLineageId: line.billLineageId!,
        sectionLineageId: line.sectionLineageId,
        newSection: line.newSection,
        ref: line.ref,
        description: line.description ?? "",
        unit: line.unit,
        kind: (line.kind ?? "measured") as VariationAddKind,
        quantity: line.quantity,
        rate: line.rate,
        amountMinor: line.amountMinor,
        note: line.note,
      };
    else if (line.action === "omit")
      input = { id: line.id, action: "omit", itemLineageId: line.itemLineageId!, note: line.note };
    else
      input = {
        id: line.id,
        action: "adjust",
        itemLineageId: line.itemLineageId!,
        quantity: line.quantity,
        rate: line.rate,
        amountMinor: line.amountMinor,
        note: line.note,
      };
    return {
      key: line.id,
      input,
      target: { ...line.target, amountMinor: line.action === "add" ? null : line.baseAmountMinor },
      priced: {
        baseAmountMinor: line.baseAmountMinor,
        newAmountMinor: line.newAmountMinor,
        deltaMinor: line.deltaMinor,
      },
      issue: line.issue,
    };
  });
}

type ItemForm = {
  item: BqItemWire;
  bill: BqBillWire;
  quantity: string;
  rate: string;
  amount: string;
};
type AddForm = {
  bill: BqBillWire;
  sectionLineageId: string;
  sectionTitle: string;
  sectionCode: string;
  ref: string;
  description: string;
  unit: BqUnit | "";
  kind: VariationAddKind;
  mode: "rate" | "amount";
  quantity: string;
  rate: string;
  amount: string;
};

/**
 * The variation's lines. While the variation is a draft (and based on the newest approved
 * version) lines are edited locally from the base version's BQ tree and saved together; the API
 * prices them (quantity × rate rounded half-up per line) and returns the totals.
 */
export function VariationEditor({
  projectId,
  variation,
  bills,
}: {
  projectId: string;
  variation: VariationDetail;
  bills: BqBillWire[];
}) {
  const t = useTranslations("variationDetail");
  const tKinds = useTranslations("variationDetail.kinds");
  const unitLabel = useUnitLabel();
  const problem = useProblemMessage();
  const router = useRouter();
  const editable = variation.permissions.canEdit && !variation.stale;
  const [rows, setRows] = useState<Row[]>(() => rowsOf(variation));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [billId, setBillId] = useState("");
  const [billData, setBillData] = useState<BqBillResponse | null>(null);
  const [loadingBill, setLoadingBill] = useState(false);
  const [itemForm, setItemForm] = useState<ItemForm | null>(null);
  const [addForm, setAddForm] = useState<AddForm | null>(null);
  const targeted = new Set(
    rows.flatMap((row) => (row.input.action === "add" ? [] : [row.input.itemLineageId])),
  );

  function change(next: Row[]) {
    setRows(next);
    setDirty(true);
  }

  async function chooseBill(id: string) {
    setBillId(id);
    setBillData(null);
    if (!id) return;
    setLoadingBill(true);
    try {
      setBillData(
        await liveRequest(
          `/projects/${projectId}/bq/versions/${variation.baseVersion.id}/bills/${id}`,
          bqBillResponseSchema,
        ),
      );
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setLoadingBill(false);
    }
  }

  const targetOf = (item: BqItemWire, bill: BqBillWire): Target => ({
    billNumber: bill.number,
    billTitle: bill.title,
    sectionTitle: bill.sections.find((section) => section.id === item.sectionId)?.title ?? null,
    ref: item.ref,
    description: item.description,
    unit: item.unit,
    unitRaw: item.unitRaw,
    quantity: item.quantity,
    rate: item.rate,
    amountMinor: item.amountMinor,
  });

  function omit(item: BqItemWire, bill: BqBillWire) {
    change([
      ...rows,
      {
        key: crypto.randomUUID(),
        input: { action: "omit", itemLineageId: item.lineageId, note: null },
        target: targetOf(item, bill),
        priced: null,
        issue: null,
      },
    ]);
  }

  function saveItemForm() {
    if (!itemForm) return;
    const { item, bill } = itemForm;
    const amountOnly = item.rate === null;
    const input: VariationLineInputWire =
      amountOnly && itemForm.amount
        ? {
            action: "adjust",
            itemLineageId: item.lineageId,
            amountMinor: decimalKesToMinor(itemForm.amount),
            note: null,
          }
        : {
            action: "adjust",
            itemLineageId: item.lineageId,
            quantity: itemForm.quantity !== (item.quantity ?? "") ? itemForm.quantity : null,
            rate: itemForm.rate !== (item.rate ?? "") ? itemForm.rate : null,
            note: null,
          };
    change([
      ...rows,
      { key: crypto.randomUUID(), input, target: targetOf(item, bill), priced: null, issue: null },
    ]);
    setItemForm(null);
  }

  function saveAddForm() {
    if (!addForm) return;
    const { bill } = addForm;
    const existing = bill.sections.find(
      (section) => section.lineageId === addForm.sectionLineageId,
    );
    const input: VariationLineInputWire = {
      action: "add",
      billLineageId: bill.lineageId,
      sectionLineageId: existing ? existing.lineageId : null,
      newSection: existing
        ? null
        : { code: addForm.sectionCode.trim() || null, title: addForm.sectionTitle.trim() },
      ref: addForm.ref.trim() || null,
      description: addForm.description.trim(),
      unit: addForm.unit || null,
      kind: addForm.kind,
      quantity: addForm.mode === "rate" ? addForm.quantity : null,
      rate: addForm.mode === "rate" ? addForm.rate : null,
      amountMinor: addForm.mode === "amount" ? decimalKesToMinor(addForm.amount) : null,
      note: null,
    };
    change([
      ...rows,
      {
        key: crypto.randomUUID(),
        input,
        target: {
          billNumber: bill.number,
          billTitle: bill.title,
          sectionTitle: existing ? existing.title : addForm.sectionTitle.trim(),
          ref: addForm.ref.trim() || null,
          description: addForm.description.trim(),
          unit: addForm.unit || null,
          unitRaw: null,
          quantity: null,
          rate: null,
          amountMinor: null,
        },
        priced: null,
        issue: null,
      },
    ]);
    setAddForm(null);
  }

  async function save() {
    setSaving(true);
    setFailure(null);
    try {
      const { variation: saved } = await liveRequest(
        `/projects/${projectId}/bq/variations/${variation.id}/lines`,
        variationResponseSchema,
        {
          method: "PUT",
          body: { lines: rows.map((row) => row.input), version: variation.version },
        },
      );
      setRows(rowsOf(saved));
      setDirty(false);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setSaving(false);
    }
  }

  const describeChange = (row: Row) => {
    const input = row.input;
    if (input.action === "omit") return t("change.omit");
    if (input.action === "add")
      return input.amountMinor !== null && input.amountMinor !== undefined
        ? t("change.addAmount", { amount: formatKES(input.amountMinor) })
        : t("change.addRate", {
            quantity: formatDecimalString(input.quantity ?? "0"),
            unit: unitLabel(input.unit ?? null, null),
            rate: formatDecimalString(input.rate ?? "0"),
          });
    const parts: string[] = [];
    if (input.quantity)
      parts.push(
        t("change.quantity", {
          from: formatDecimalString(row.target.quantity ?? "0"),
          to: formatDecimalString(input.quantity),
        }),
      );
    if (input.rate)
      parts.push(
        t("change.rate", {
          from: formatDecimalString(row.target.rate ?? "0"),
          to: formatDecimalString(input.rate),
        }),
      );
    if (input.amountMinor !== null && input.amountMinor !== undefined)
      parts.push(t("change.amount", { amount: formatKES(input.amountMinor) }));
    return parts.join(" · ");
  };

  const itemFormValid =
    itemForm !== null &&
    (itemForm.item.rate === null && itemForm.amount
      ? KES.test(itemForm.amount)
      : DECIMAL.test(itemForm.quantity) &&
        DECIMAL.test(itemForm.rate) &&
        (itemForm.quantity !== (itemForm.item.quantity ?? "") ||
          itemForm.rate !== (itemForm.item.rate ?? "")));
  const addFormValid =
    addForm !== null &&
    addForm.description.trim().length > 0 &&
    (addForm.sectionLineageId !== "" || addForm.sectionTitle.trim().length > 0) &&
    (addForm.mode === "amount"
      ? KES.test(addForm.amount)
      : DECIMAL.test(addForm.quantity) && DECIMAL.test(addForm.rate) && addForm.unit !== "");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <VariationActions projectId={projectId} variation={variation} dirty={dirty} />
      </div>
      {failure ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
        >
          {failure}
        </p>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("lines.title")}</h2>
          </CardTitle>
          <CardDescription>
            {editable
              ? t("lines.editable")
              : variation.stale
                ? t("lines.stale")
                : t("lines.frozen")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-0">
          {rows.length ? (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <caption className="sr-only">{t("lines.title")}</caption>
                <thead>
                  <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <th scope="col" className="w-10 py-2 pl-4 font-medium">
                      #
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("lines.cols.item")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("lines.cols.change")}
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      {t("lines.cols.base")}
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      {t("lines.cols.new")}
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      {t("lines.cols.delta")}
                    </th>
                    {editable ? (
                      <th scope="col" className="py-2 pr-4 font-medium">
                        <span className="sr-only">{t("lines.cols.actions")}</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.key} className="border-b align-top last:border-0">
                      <td className="py-2 pl-4 text-xs text-muted-foreground">{index + 1}</td>
                      <th scope="row" className="py-2 pr-2 text-left font-normal">
                        <StatusBadge
                          tone={
                            row.input.action === "omit"
                              ? "danger"
                              : row.input.action === "add"
                                ? "success"
                                : "info"
                          }
                        >
                          {t(`actionLabels.${row.input.action}`)}
                        </StatusBadge>{" "}
                        <span className="text-xs text-muted-foreground">
                          {t("lines.where", {
                            bill: row.target.billNumber,
                            section: row.target.sectionTitle ?? "—",
                          })}
                        </span>
                        <span className="block">
                          {row.target.ref ? (
                            <span className="font-mono text-xs">{row.target.ref} · </span>
                          ) : null}
                          {row.target.description}
                        </span>
                        {row.input.action === "add" ? (
                          <span className="text-xs text-muted-foreground">
                            {tKinds(row.input.kind)}
                          </span>
                        ) : null}
                        {row.issue ? (
                          <span className="mt-1 block text-xs text-destructive">
                            {t(`issues.${row.issue}`)}
                          </span>
                        ) : null}
                      </th>
                      <td className="py-2 pr-2 text-xs">{describeChange(row)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">
                        {row.priced ? formatKES(row.priced.baseAmountMinor) : t("lines.unsaved")}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">
                        {row.priced ? formatKES(row.priced.newAmountMinor) : t("lines.unsaved")}
                      </td>
                      <td className="py-2 pr-4 text-right font-medium tabular-nums">
                        {row.priced ? formatKES(row.priced.deltaMinor) : t("lines.unsaved")}
                      </td>
                      {editable ? (
                        <td className="py-2 pr-4">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={t("lines.remove", { line: index + 1 })}
                            onClick={() => change(rows.filter((other) => other.key !== row.key))}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-6 text-sm text-muted-foreground">{t("lines.empty")}</p>
          )}
          {editable ? (
            <div className="flex flex-wrap items-center gap-2 px-6">
              <Button type="button" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
                {t("lines.save")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!dirty || saving}
                onClick={() => {
                  setRows(rowsOf(variation));
                  setDirty(false);
                }}
              >
                <Undo2 aria-hidden /> {t("lines.discard")}
              </Button>
              {dirty ? (
                <span role="status" className="text-sm text-warning-foreground dark:text-warning">
                  {t("lines.dirty")}
                </span>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {editable ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("picker.title")}</h2>
            </CardTitle>
            <CardDescription>
              {t("picker.description", { version: variation.baseVersion.versionNo })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 px-0">
            <div className="flex flex-wrap items-end gap-2 px-6">
              <Field className="w-full sm:w-80">
                <FieldLabel htmlFor="picker-bill">{t("picker.bill")}</FieldLabel>
                <select
                  id="picker-bill"
                  value={billId}
                  onChange={(event) => void chooseBill(event.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                >
                  <option value="">{t("picker.choose")}</option>
                  {bills.map((bill) => (
                    <option key={bill.id} value={bill.id}>
                      {t("picker.billOption", { number: bill.number, title: bill.title })}
                    </option>
                  ))}
                </select>
              </Field>
              {billData ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setAddForm({
                      bill: billData.bill,
                      sectionLineageId: billData.bill.sections[0]?.lineageId ?? "",
                      sectionTitle: "",
                      sectionCode: "",
                      ref: "",
                      description: "",
                      unit: "",
                      kind: "measured",
                      mode: "rate",
                      quantity: "",
                      rate: "",
                      amount: "",
                    })
                  }
                >
                  <Plus aria-hidden /> {t("picker.addItem")}
                </Button>
              ) : null}
            </div>
            {loadingBill ? (
              <p role="status" className="px-6 text-sm text-muted-foreground">
                {t("picker.loading")}
              </p>
            ) : null}
            {billData ? (
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <caption className="sr-only">
                    {t("picker.billOption", {
                      number: billData.bill.number,
                      title: billData.bill.title,
                    })}
                  </caption>
                  <thead>
                    <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                      <th scope="col" className="py-2 pl-4 font-medium">
                        {t("picker.cols.item")}
                      </th>
                      <th scope="col" className="py-2 text-right font-medium">
                        {t("picker.cols.qty")}
                      </th>
                      <th scope="col" className="py-2 text-right font-medium">
                        {t("picker.cols.rate")}
                      </th>
                      <th scope="col" className="py-2 text-right font-medium">
                        {t("picker.cols.amount")}
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        <span className="sr-only">{t("lines.cols.actions")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {billData.items.map((item) => {
                      const used = targeted.has(item.lineageId);
                      const label = item.ref
                        ? `${item.ref} · ${item.description.slice(0, 40)}`
                        : item.description.slice(0, 40);
                      return (
                        <tr key={item.id} className="border-b align-top last:border-0">
                          <th scope="row" className="py-2 pr-2 pl-4 text-left font-normal">
                            {item.ref ? (
                              <span className="font-mono text-xs">{item.ref} · </span>
                            ) : null}
                            {item.description}
                            {item.amountSource === "omitted" ? (
                              <StatusBadge tone="neutral" className="ml-1">
                                {t("picker.omitted")}
                              </StatusBadge>
                            ) : null}
                          </th>
                          <td className="py-2 pr-2 text-right tabular-nums">
                            {item.quantity === null
                              ? ""
                              : `${formatDecimalString(item.quantity)} ${unitLabel(item.unit, item.unitRaw)}`}
                          </td>
                          <td className="py-2 pr-2 text-right tabular-nums">
                            {item.rate === null ? "" : formatDecimalString(item.rate)}
                          </td>
                          <td className="py-2 pr-2 text-right tabular-nums">
                            {formatKES(item.amountMinor)}
                          </td>
                          <td className="py-2 pr-4">
                            <span className="flex gap-1">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={used}
                                aria-label={t("picker.changeLabel", { item: label })}
                                onClick={() =>
                                  setItemForm({
                                    item,
                                    bill: billData.bill,
                                    quantity: item.quantity ?? "",
                                    rate: item.rate ?? "",
                                    amount: "",
                                  })
                                }
                              >
                                <Pencil aria-hidden /> {t("picker.change")}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={used || item.amountSource === "omitted"}
                                aria-label={t("picker.omitLabel", { item: label })}
                                onClick={() => omit(item, billData.bill)}
                              >
                                <Minus aria-hidden /> {t("picker.omit")}
                              </Button>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Dialog
        open={itemForm !== null}
        onOpenChange={(next) => (next ? undefined : setItemForm(null))}
      >
        <DialogContent showCloseButton={false}>
          {itemForm ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("itemForm.title")}</DialogTitle>
                <DialogDescription>
                  {itemForm.item.ref ? `${itemForm.item.ref} · ` : ""}
                  {itemForm.item.description.slice(0, 120)}
                </DialogDescription>
              </DialogHeader>
              <form
                id="item-form"
                className="grid gap-3 sm:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (itemFormValid) saveItemForm();
                }}
              >
                <Field>
                  <FieldLabel htmlFor="item-quantity">
                    {t("itemForm.quantity", {
                      unit: unitLabel(itemForm.item.unit, itemForm.item.unitRaw),
                    })}
                  </FieldLabel>
                  <Input
                    id="item-quantity"
                    inputMode="decimal"
                    value={itemForm.quantity}
                    onChange={(event) =>
                      setItemForm({ ...itemForm, quantity: event.target.value.trim() })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="item-rate">{t("itemForm.rate")}</FieldLabel>
                  <Input
                    id="item-rate"
                    inputMode="decimal"
                    value={itemForm.rate}
                    onChange={(event) =>
                      setItemForm({ ...itemForm, rate: event.target.value.trim() })
                    }
                  />
                </Field>
                {itemForm.item.rate === null ? (
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="item-amount">{t("itemForm.amount")}</FieldLabel>
                    <Input
                      id="item-amount"
                      inputMode="decimal"
                      value={itemForm.amount}
                      onChange={(event) =>
                        setItemForm({ ...itemForm, amount: event.target.value.trim() })
                      }
                    />
                    <FieldDescription>{t("itemForm.amountHint")}</FieldDescription>
                  </Field>
                ) : null}
                <p className="text-xs text-muted-foreground sm:col-span-2">{t("itemForm.hint")}</p>
              </form>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setItemForm(null)}>
                  {t("itemForm.cancel")}
                </Button>
                <Button type="submit" form="item-form" disabled={!itemFormValid}>
                  {t("itemForm.submit")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={addForm !== null}
        onOpenChange={(next) => (next ? undefined : setAddForm(null))}
      >
        <DialogContent showCloseButton={false} className="max-h-[90vh] overflow-y-auto">
          {addForm ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("addForm.title")}</DialogTitle>
                <DialogDescription>
                  {t("picker.billOption", {
                    number: addForm.bill.number,
                    title: addForm.bill.title,
                  })}
                </DialogDescription>
              </DialogHeader>
              <form
                id="add-form"
                className="grid gap-3 sm:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (addFormValid) saveAddForm();
                }}
              >
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="add-section">{t("addForm.section")}</FieldLabel>
                  <select
                    id="add-section"
                    value={addForm.sectionLineageId}
                    onChange={(event) =>
                      setAddForm({ ...addForm, sectionLineageId: event.target.value })
                    }
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    {addForm.bill.sections.map((section) => (
                      <option key={section.id} value={section.lineageId}>
                        {section.code ? `${section.code} · ` : ""}
                        {section.title ?? t("addForm.untitled")}
                      </option>
                    ))}
                    <option value="">{t("addForm.newSection")}</option>
                  </select>
                </Field>
                {addForm.sectionLineageId === "" ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor="add-section-code">{t("addForm.sectionCode")}</FieldLabel>
                      <Input
                        id="add-section-code"
                        maxLength={30}
                        value={addForm.sectionCode}
                        onChange={(event) =>
                          setAddForm({ ...addForm, sectionCode: event.target.value })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="add-section-title">
                        {t("addForm.sectionTitle")}
                      </FieldLabel>
                      <Input
                        id="add-section-title"
                        maxLength={300}
                        value={addForm.sectionTitle}
                        onChange={(event) =>
                          setAddForm({ ...addForm, sectionTitle: event.target.value })
                        }
                        required
                      />
                    </Field>
                  </>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="add-ref">{t("addForm.ref")}</FieldLabel>
                  <Input
                    id="add-ref"
                    maxLength={30}
                    value={addForm.ref}
                    onChange={(event) => setAddForm({ ...addForm, ref: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="add-kind">{t("addForm.kind")}</FieldLabel>
                  <select
                    id="add-kind"
                    value={addForm.kind}
                    onChange={(event) =>
                      setAddForm({ ...addForm, kind: event.target.value as VariationAddKind })
                    }
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    {VARIATION_ADD_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {tKinds(kind)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="add-description">{t("addForm.description")}</FieldLabel>
                  <Textarea
                    id="add-description"
                    rows={2}
                    maxLength={4000}
                    value={addForm.description}
                    onChange={(event) =>
                      setAddForm({ ...addForm, description: event.target.value })
                    }
                    required
                  />
                </Field>
                <fieldset className="space-y-2 sm:col-span-2">
                  <legend className="text-sm font-medium">{t("addForm.pricing")}</legend>
                  {(["rate", "amount"] as const).map((mode) => (
                    <label key={mode} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="add-mode"
                        value={mode}
                        checked={addForm.mode === mode}
                        onChange={() => setAddForm({ ...addForm, mode })}
                        className="size-4 accent-primary"
                      />
                      {t(`addForm.modes.${mode}`)}
                    </label>
                  ))}
                </fieldset>
                {addForm.mode === "rate" ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor="add-unit">{t("addForm.unit")}</FieldLabel>
                      <select
                        id="add-unit"
                        value={addForm.unit}
                        onChange={(event) =>
                          setAddForm({ ...addForm, unit: event.target.value as BqUnit | "" })
                        }
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      >
                        <option value="">{t("picker.choose")}</option>
                        {BQ_UNITS.filter((unit) => unit !== "other").map((unit) => (
                          <option key={unit} value={unit}>
                            {unitLabel(unit, null)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="add-quantity">{t("addForm.quantity")}</FieldLabel>
                      <Input
                        id="add-quantity"
                        inputMode="decimal"
                        value={addForm.quantity}
                        onChange={(event) =>
                          setAddForm({ ...addForm, quantity: event.target.value.trim() })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="add-rate">{t("addForm.rate")}</FieldLabel>
                      <Input
                        id="add-rate"
                        inputMode="decimal"
                        value={addForm.rate}
                        onChange={(event) =>
                          setAddForm({ ...addForm, rate: event.target.value.trim() })
                        }
                      />
                    </Field>
                  </>
                ) : (
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="add-amount">{t("addForm.amount")}</FieldLabel>
                    <Input
                      id="add-amount"
                      inputMode="decimal"
                      value={addForm.amount}
                      onChange={(event) =>
                        setAddForm({ ...addForm, amount: event.target.value.trim() })
                      }
                    />
                  </Field>
                )}
              </form>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAddForm(null)}>
                  {t("itemForm.cancel")}
                </Button>
                <Button type="submit" form="add-form" disabled={!addFormValid}>
                  {t("addForm.submit")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
