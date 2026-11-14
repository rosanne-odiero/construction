"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import {
  activityProgressRequestSchema,
  createActivityRequestSchema,
  messageResponseSchema,
  scheduleActivityResponseSchema,
  updateActivityRequestSchema,
  type ScheduleItem,
  type WbsNode,
} from "@pm-buddy/validation";
import { BqItemPicker, type BqItemChoice } from "@/components/procurement/p2p/bq-item-picker";
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
import { liveRequest } from "@/lib/live-api";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import { FormError, selectClass, useScheduleMutation } from "./use-schedule-mutation";

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Create or edit a task: code, name, WBS node, duration, start constraint and a BQ item. */
export function ActivityDialog({
  projectId,
  item,
  open,
  nodes,
  canPickBq,
  onClose,
}: {
  projectId: string;
  /** Null for a new activity. */
  item: ScheduleItem | null;
  open: boolean;
  nodes: WbsNode[];
  canPickBq: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("schedule.activity");
  const { busy, error, setError, run } = useScheduleMutation();
  const [bq, setBq] = useState<BqItemChoice | null>(
    item?.bqItem
      ? {
          lineageId: item.bqItem.lineageId,
          ref: item.bqItem.ref,
          description: item.bqItem.description,
        }
      : null,
  );
  const [picking, setPicking] = useState(false);

  function save(form: FormData) {
    const startText = text(form, "startNoEarlierThan");
    const start = parseCalendarInput(startText);
    const fields = {
      code: text(form, "code"),
      name: text(form, "name"),
      wbsNodeId: text(form, "wbsNodeId") || null,
      durationDays: Number(text(form, "durationDays")),
      startNoEarlierThan: start ?? null,
    };
    const bqChanged = (bq?.lineageId ?? null) !== (item?.bqItem?.lineageId ?? null);
    const parsed = item
      ? updateActivityRequestSchema.safeParse({
          ...fields,
          ...(bqChanged ? { bqItemLineageId: bq?.lineageId ?? null } : {}),
          version: item.version,
        })
      : createActivityRequestSchema.safeParse({
          ...fields,
          bqItemLineageId: bq?.lineageId ?? null,
        });
    if (!parsed.success || start === undefined) {
      setError(t("invalid"));
      return;
    }
    void run(
      () =>
        liveRequest(
          item
            ? `/projects/${projectId}/schedule/activities/${item.id}`
            : `/projects/${projectId}/schedule/activities`,
          scheduleActivityResponseSchema,
          { method: item ? "PATCH" : "POST", body: parsed.data },
        ),
      onClose,
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item ? t("editTitle", { name: item.name }) : t("addTitle")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save(new FormData(event.currentTarget));
          }}
        >
          <FormError message={error} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="activity-code">{t("code")}</FieldLabel>
              <Input
                id="activity-code"
                name="code"
                defaultValue={item?.code ?? ""}
                maxLength={20}
                required
                autoFocus
                disabled={busy}
              />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="activity-name">{t("name")}</FieldLabel>
              <Input
                id="activity-name"
                name="name"
                defaultValue={item?.name ?? ""}
                maxLength={150}
                required
                disabled={busy}
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="activity-duration">{t("duration")}</FieldLabel>
              <Input
                id="activity-duration"
                name="durationDays"
                type="number"
                min={1}
                max={1000}
                step={1}
                defaultValue={item?.durationDays ?? 5}
                required
                disabled={busy}
                aria-describedby="activity-duration-hint"
              />
              <FieldDescription id="activity-duration-hint">{t("durationHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="activity-start">{t("startNoEarlierThan")}</FieldLabel>
              <Input
                id="activity-start"
                name="startNoEarlierThan"
                defaultValue={calendarInput(item?.startNoEarlierThan ?? null)}
                placeholder="DD/MM/YYYY"
                disabled={busy}
                aria-describedby="activity-start-hint"
              />
              <FieldDescription id="activity-start-hint">{t("startHint")}</FieldDescription>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="activity-wbs">{t("wbs")}</FieldLabel>
            <select
              id="activity-wbs"
              name="wbsNodeId"
              className={selectClass}
              defaultValue={item?.wbsNodeId ?? ""}
              disabled={busy}
            >
              <option value="">{t("noWbs")}</option>
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.code} {node.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("bqItem")}</p>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {bq ? `${bq.ref ?? "—"} · ${bq.description}` : t("noBq")}
            </p>
            {canPickBq ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setPicking(true)}
                >
                  <Search aria-hidden className="size-4" />
                  {t("chooseBq")}
                </Button>
                {bq ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setBq(null)}
                  >
                    {t("clearBq")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
        {canPickBq ? (
          <BqItemPicker
            projectId={projectId}
            open={picking}
            onClose={() => setPicking(false)}
            onChoose={(choice) => {
              setBq(choice);
              setPicking(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Actual dates and physical progress (a whole percent, or quantity done of a total). */
export function ProgressDialog({
  projectId,
  item,
  onClose,
}: {
  projectId: string;
  item: ScheduleItem;
  onClose: () => void;
}) {
  const t = useTranslations("schedule.progress");
  const { busy, error, setError, run } = useScheduleMutation();
  const [basis, setBasis] = useState(item.progress?.basis ?? "physical");

  function save(form: FormData) {
    const actualStart = parseCalendarInput(text(form, "actualStart"));
    const actualFinish = parseCalendarInput(text(form, "actualFinish"));
    const percentText = text(form, "percentComplete");
    const parsed = activityProgressRequestSchema.safeParse({
      version: item.version,
      actualStart,
      actualFinish,
      basis,
      ...(basis === "physical"
        ? { percentComplete: percentText === "" ? null : Number(percentText) }
        : {
            quantityDone: text(form, "quantityDone") || "0",
            quantityTotal: text(form, "quantityTotal"),
            quantityUnit: text(form, "quantityUnit"),
          }),
    });
    if (!parsed.success || actualStart === undefined || actualFinish === undefined) {
      setError(t("invalid"));
      return;
    }
    void run(
      () =>
        liveRequest(
          `/projects/${projectId}/schedule/activities/${item.id}/progress`,
          scheduleActivityResponseSchema,
          { method: "PUT", body: parsed.data },
        ),
      onClose,
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title", { name: item.name })}</DialogTitle>
          <DialogDescription>{t("explainer")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save(new FormData(event.currentTarget));
          }}
        >
          <FormError message={error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="progress-start">{t("actualStart")}</FieldLabel>
              <Input
                id="progress-start"
                name="actualStart"
                defaultValue={calendarInput(item.actualStart)}
                placeholder="DD/MM/YYYY"
                disabled={busy}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="progress-finish">{t("actualFinish")}</FieldLabel>
              <Input
                id="progress-finish"
                name="actualFinish"
                defaultValue={calendarInput(item.actualFinish)}
                placeholder="DD/MM/YYYY"
                disabled={busy}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t("dateHint")}</p>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("basis")}</legend>
            {(["physical", "quantity"] as const).map((option) => (
              <label key={option} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="basis"
                  value={option}
                  checked={basis === option}
                  onChange={() => setBasis(option)}
                  disabled={busy}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{t(`bases.${option}`)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`bases.${option}Hint`)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {basis === "physical" ? (
            <Field>
              <FieldLabel htmlFor="progress-percent">{t("percent")}</FieldLabel>
              <Input
                id="progress-percent"
                name="percentComplete"
                type="number"
                min={0}
                max={100}
                step={1}
                defaultValue={
                  item.progress?.basis === "physical" ? (item.progress.percentComplete ?? "") : ""
                }
                disabled={busy}
                aria-describedby="progress-percent-hint"
              />
              <FieldDescription id="progress-percent-hint">{t("percentHint")}</FieldDescription>
            </Field>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="progress-done">{t("quantityDone")}</FieldLabel>
                <Input
                  id="progress-done"
                  name="quantityDone"
                  inputMode="decimal"
                  defaultValue={item.progress?.quantityDone ?? ""}
                  disabled={busy}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="progress-total">{t("quantityTotal")}</FieldLabel>
                <Input
                  id="progress-total"
                  name="quantityTotal"
                  inputMode="decimal"
                  defaultValue={item.progress?.quantityTotal ?? ""}
                  required
                  disabled={busy}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="progress-unit">{t("quantityUnit")}</FieldLabel>
                <Input
                  id="progress-unit"
                  name="quantityUnit"
                  defaultValue={item.progress?.quantityUnit ?? ""}
                  maxLength={20}
                  required
                  disabled={busy}
                />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Deletes an unstarted activity (its dependencies go with it). */
export function DeleteActivityDialog({
  projectId,
  item,
  onClose,
}: {
  projectId: string;
  item: ScheduleItem;
  onClose: () => void;
}) {
  const t = useTranslations("schedule.activity");
  const { busy, error, run } = useScheduleMutation();
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("deleteTitle", { name: item.name })}</DialogTitle>
          <DialogDescription>{t("deleteDescription")}</DialogDescription>
        </DialogHeader>
        <FormError message={error} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void run(
                () =>
                  liveRequest(
                    `/projects/${projectId}/schedule/activities/${item.id}?version=${item.version}`,
                    messageResponseSchema,
                    { method: "DELETE" },
                  ),
                onClose,
              )
            }
          >
            {t("delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
