"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { nairobiDate } from "@pm-buddy/domain";
import {
  contractSettingsResponseSchema,
  measurementResponseSchema,
  valuationResponseSchema,
  type ContractSettings,
} from "@pm-buddy/validation";
import { PhotoUpload } from "@/components/quality/photos";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { parseKesInput } from "@/lib/spending";
import { parseQuantityInput } from "@/lib/valuations";
import { useValuationProblem } from "./use-valuation-problem";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function Failure({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

/** Starts an interim valuation or a retention release (bq.edit); opens the new draft. */
export function CreateValuationForm({
  projectId,
  release,
  minDate,
}: {
  projectId: string;
  release: { practical: boolean; final: boolean };
  minDate: string | null;
}) {
  const t = useTranslations("valuations.certificates.create");
  const problem = useValuationProblem();
  const router = useRouter();
  const today = nairobiDate();
  const kinds: ("interim" | "practical" | "final")[] = [
    "interim",
    ...(release.practical ? (["practical"] as const) : []),
    ...(release.final ? (["final"] as const) : []),
  ];
  const [kind, setKind] = useState<string>("interim");
  const [date, setDate] = useState(today);
  const [stores, setStores] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setFailure(null);
    try {
      const result = await liveRequest(
        `/projects/${projectId}/valuations`,
        valuationResponseSchema,
        {
          method: "POST",
          body:
            kind === "interim"
              ? { kind: "interim", valuationDate: date, materialsFromStores: stores }
              : { kind: "retention_release", releaseStage: kind, valuationDate: date },
        },
      );
      router.push(`/valuations/${result.valuation.id}`);
    } catch (error) {
      setFailure(problem(error));
      setBusy(false);
    }
  }

  return (
    <form
      className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("title")}</h3>
      <Field>
        <FieldLabel htmlFor="new-valuation-kind">{t("kind")}</FieldLabel>
        <select
          id="new-valuation-kind"
          className={selectClass}
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          {kinds.map((value) => (
            <option key={value} value={value}>
              {t(`kinds.${value}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="new-valuation-date">{t("date")}</FieldLabel>
        <Input
          id="new-valuation-date"
          type="date"
          value={date}
          max={today}
          min={minDate ?? undefined}
          onChange={(event) => setDate(event.target.value)}
        />
        <FieldDescription>{t("dateHint")}</FieldDescription>
      </Field>
      {kind === "interim" ? (
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={stores}
            onChange={(event) => setStores(event.target.checked)}
          />
          <span>
            {t("stores")}
            <span className="block text-xs text-muted-foreground">{t("storesHint")}</span>
          </span>
        </label>
      ) : null}
      <div className="sm:col-span-2">
        <Failure message={failure} />
        <Button type="submit" disabled={busy || !/^\d{4}-\d{2}-\d{2}$/.test(date)}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

/** A new version of the project's retention, VAT, materials and release terms (finance.manage). */
export function ContractSettingsForm({
  projectId,
  settings,
}: {
  projectId: string;
  settings: ContractSettings;
}) {
  const t = useTranslations("valuations.settings");
  const problem = useValuationProblem();
  const router = useRouter();
  const [values, setValues] = useState({
    retentionPercent: settings.retentionPercent,
    retentionCapPercent: settings.retentionCapPercent ?? "",
    vatPercent: settings.vatPercent,
    materialsPercent: settings.materialsPercent,
    practicalReleasePercent: settings.practicalReleasePercent,
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fields = [
    "retentionPercent",
    "retentionCapPercent",
    "vatPercent",
    "materialsPercent",
    "practicalReleasePercent",
  ] as const;
  const percent = (value: string) => /^\d{1,3}(\.\d{1,2})?$/.test(value.trim());
  const valid = fields.every((field) =>
    field === "retentionCapPercent" && values[field].trim() === "" ? true : percent(values[field]),
  );

  async function save() {
    setBusy(true);
    setFailure(null);
    setSaved(false);
    try {
      await liveRequest(
        `/projects/${projectId}/contract-settings`,
        contractSettingsResponseSchema,
        {
          method: "PUT",
          body: {
            version: settings.version,
            retentionPercent: values.retentionPercent.trim(),
            retentionCapPercent: values.retentionCapPercent.trim() || null,
            vatPercent: values.vatPercent.trim(),
            materialsPercent: values.materialsPercent.trim(),
            practicalReleasePercent: values.practicalReleasePercent.trim(),
          },
        },
      );
      setSaved(true);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2 lg:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 className="font-semibold sm:col-span-2 lg:col-span-3">{t("title")}</h3>
      {fields.map((field) => (
        <Field key={field}>
          <FieldLabel htmlFor={`settings-${field}`}>{t(`fields.${field}`)}</FieldLabel>
          <Input
            id={`settings-${field}`}
            inputMode="decimal"
            autoComplete="off"
            value={values[field]}
            onChange={(event) =>
              setValues((current) => ({ ...current, [field]: event.target.value }))
            }
          />
          <FieldDescription>{t(`hints.${field}`)}</FieldDescription>
        </Field>
      ))}
      <div className="space-y-2 sm:col-span-2 lg:col-span-3">
        <p className="text-xs text-muted-foreground">{t("review")}</p>
        <Failure message={failure} />
        {saved ? (
          <p role="status" className="text-sm text-success">
            {t("saved")}
          </p>
        ) : null}
        <Button type="submit" disabled={busy || !valid}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

/** A draft's date, notes and materials-from-stores choice, materials and adjustments (bq.edit). */
export function DraftEditor({
  valuationId,
  version,
  interim,
  valuationDate,
  notes,
  materialsFromStores,
  items,
}: {
  valuationId: string;
  version: number;
  interim: boolean;
  valuationDate: string;
  notes: string | null;
  materialsFromStores: boolean;
  items: { lineageId: string; label: string }[];
}) {
  const t = useTranslations("valuations.valuation.editor");
  const tKinds = useTranslations("valuations.adjustmentKinds");
  const problem = useValuationProblem();
  const router = useRouter();
  const today = nairobiDate();
  const [date, setDate] = useState(valuationDate);
  const [text, setText] = useState(notes ?? "");
  const [stores, setStores] = useState(materialsFromStores);
  const [material, setMaterial] = useState({
    lineageId: items[0]?.lineageId ?? "",
    description: "",
    unit: "",
    quantity: "",
    amount: "",
    reference: "",
  });
  const [adjustment, setAdjustment] = useState({ kind: "advance", description: "", amount: "" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function send(path: string, body: Record<string, unknown>, method: "POST" | "PATCH") {
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest(path, valuationResponseSchema, { method, body: { version, ...body } });
      router.refresh();
      return true;
    } catch (error) {
      setFailure(problem(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const quantity = parseQuantityInput(material.quantity);
  const materialAmount = parseKesInput(material.amount);
  const signed = adjustment.kind === "advance_recovery" || adjustment.kind === "contra_charge";
  const adjustmentAmount = (() => {
    const raw = adjustment.amount.trim();
    const negative = raw.startsWith("-");
    const minor = parseKesInput(negative ? raw.slice(1) : raw);
    if (minor === null) return null;
    if (adjustment.kind === "other") return negative ? -minor : minor;
    return signed ? -minor : minor;
  })();

  return (
    <section aria-labelledby="draft-editor" className="space-y-4">
      <h2 id="draft-editor" className="text-lg font-semibold">
        {t("title")}
      </h2>
      <Failure message={failure} />
      <form
        className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send(
            `/valuations/${valuationId}`,
            {
              valuationDate: date,
              notes: text.trim() || null,
              ...(interim ? { materialsFromStores: stores } : {}),
            },
            "PATCH",
          );
        }}
      >
        <Field>
          <FieldLabel htmlFor="draft-date">{t("date")}</FieldLabel>
          <Input
            id="draft-date"
            type="date"
            value={date}
            max={today}
            onChange={(event) => setDate(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="draft-notes">{t("notes")}</FieldLabel>
          <Textarea
            id="draft-notes"
            rows={2}
            maxLength={1000}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        {interim ? (
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={stores}
              onChange={(event) => setStores(event.target.checked)}
            />
            <span>
              {t("stores")}
              <span className="block text-xs text-muted-foreground">{t("storesHint")}</span>
            </span>
          </label>
        ) : null}
        <div className="sm:col-span-2">
          <Button type="submit" variant="secondary" disabled={busy}>
            {t("saveDetails")}
          </Button>
        </div>
      </form>
      {interim ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <form
            className="grid gap-3 rounded-xl border p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (quantity === null || materialAmount === null) return;
              void send(
                `/valuations/${valuationId}/materials`,
                {
                  bqItemLineageId: material.lineageId,
                  description: material.description.trim(),
                  unit: material.unit.trim() || null,
                  quantity,
                  amountMinor: materialAmount,
                  reference: material.reference.trim() || null,
                },
                "POST",
              ).then((done) => {
                if (done)
                  setMaterial((current) => ({
                    ...current,
                    description: "",
                    quantity: "",
                    amount: "",
                  }));
              });
            }}
          >
            <h3 className="font-semibold">{t("materialsTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("materialsHint")}</p>
            <Field>
              <FieldLabel htmlFor="material-item">{t("item")}</FieldLabel>
              <select
                id="material-item"
                className={selectClass}
                value={material.lineageId}
                onChange={(event) =>
                  setMaterial((current) => ({ ...current, lineageId: event.target.value }))
                }
              >
                {items.map((item) => (
                  <option key={item.lineageId} value={item.lineageId}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="material-description">{t("description")}</FieldLabel>
              <Input
                id="material-description"
                maxLength={200}
                value={material.description}
                onChange={(event) =>
                  setMaterial((current) => ({ ...current, description: event.target.value }))
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="material-quantity">{t("quantity")}</FieldLabel>
                <Input
                  id="material-quantity"
                  inputMode="decimal"
                  value={material.quantity}
                  onChange={(event) =>
                    setMaterial((current) => ({ ...current, quantity: event.target.value }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="material-unit">{t("unit")}</FieldLabel>
                <Input
                  id="material-unit"
                  maxLength={20}
                  value={material.unit}
                  onChange={(event) =>
                    setMaterial((current) => ({ ...current, unit: event.target.value }))
                  }
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="material-amount">{t("amount")}</FieldLabel>
              <Input
                id="material-amount"
                inputMode="decimal"
                value={material.amount}
                onChange={(event) =>
                  setMaterial((current) => ({ ...current, amount: event.target.value }))
                }
              />
              <FieldDescription>{t("amountHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="material-reference">{t("reference")}</FieldLabel>
              <Input
                id="material-reference"
                maxLength={60}
                value={material.reference}
                onChange={(event) =>
                  setMaterial((current) => ({ ...current, reference: event.target.value }))
                }
              />
            </Field>
            <div>
              <Button
                type="submit"
                variant="secondary"
                disabled={
                  busy ||
                  !material.lineageId ||
                  material.description.trim().length < 2 ||
                  quantity === null ||
                  quantity === "0" ||
                  materialAmount === null
                }
              >
                {t("addMaterial")}
              </Button>
            </div>
          </form>
          <form
            className="grid content-start gap-3 rounded-xl border p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (adjustmentAmount === null) return;
              void send(
                `/valuations/${valuationId}/adjustments`,
                {
                  kind: adjustment.kind,
                  description: adjustment.description.trim(),
                  amountMinor: adjustmentAmount,
                },
                "POST",
              ).then((done) => {
                if (done) setAdjustment((current) => ({ ...current, description: "", amount: "" }));
              });
            }}
          >
            <h3 className="font-semibold">{t("adjustmentsTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("adjustmentsHint")}</p>
            <Field>
              <FieldLabel htmlFor="adjustment-kind">{t("kind")}</FieldLabel>
              <select
                id="adjustment-kind"
                className={selectClass}
                value={adjustment.kind}
                onChange={(event) =>
                  setAdjustment((current) => ({ ...current, kind: event.target.value }))
                }
              >
                {(["advance", "advance_recovery", "contra_charge", "other"] as const).map(
                  (value) => (
                    <option key={value} value={value}>
                      {tKinds(value)}
                    </option>
                  ),
                )}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="adjustment-description">{t("description")}</FieldLabel>
              <Input
                id="adjustment-description"
                maxLength={200}
                value={adjustment.description}
                onChange={(event) =>
                  setAdjustment((current) => ({ ...current, description: event.target.value }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="adjustment-amount">{t("adjustmentAmount")}</FieldLabel>
              <Input
                id="adjustment-amount"
                inputMode="decimal"
                value={adjustment.amount}
                onChange={(event) =>
                  setAdjustment((current) => ({ ...current, amount: event.target.value }))
                }
              />
              <FieldDescription>
                {adjustment.kind === "other"
                  ? t("otherHint")
                  : signed
                    ? t("deductHint")
                    : t("addHint")}
              </FieldDescription>
            </Field>
            <div>
              <Button
                type="submit"
                variant="secondary"
                disabled={
                  busy || adjustment.description.trim().length < 3 || adjustmentAmount === null
                }
              >
                {t("addAdjustment")}
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

/** Adds evidence to a pending measurement: take a photo now, then link it. */
export function AddMeasurementPhoto({
  projectId,
  siteId,
  measurementId,
  caption,
}: {
  projectId: string;
  siteId: string;
  measurementId: string;
  caption: string;
}) {
  const t = useTranslations("valuations.measurement");
  const problem = useValuationProblem();
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <PhotoUpload
        projectId={projectId}
        siteId={siteId}
        caption={caption}
        label={t("addPhoto")}
        onUploaded={(photo) => {
          setFailure(null);
          liveRequest(
            `/projects/${projectId}/measurements/${measurementId}/photos`,
            measurementResponseSchema,
            { method: "POST", body: { photoIds: [photo.id] } },
          )
            .then(() => router.refresh())
            .catch((error: unknown) => setFailure(problem(error)));
        }}
      />
      <Failure message={failure} />
    </div>
  );
}
