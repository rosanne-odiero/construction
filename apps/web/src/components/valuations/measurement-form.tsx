"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ShieldCheck } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import {
  measurementItemsResponseSchema,
  measurementResponseSchema,
  sitePhotosResponseSchema,
  type MeasurementItem,
  type QualityPhoto,
} from "@pm-buddy/validation";
import { PhotoThumbs, PhotoUpload } from "@/components/quality/photos";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FoundationApiError } from "@/lib/foundation-api";
import { liveRequest } from "@/lib/live-api";
import { photoThumbnail } from "@/lib/quality";
import { formatCalendarDate, formatDecimalString, formatKES } from "@/lib/format";
import { exceedsQuantity, itemLabel, parseQuantityInput } from "@/lib/valuations";
import { useValuationProblem } from "./use-valuation-problem";

const MAX_PHOTOS = 6;
const selectClass =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:text-sm";

/**
 * Records the quantity done to date of a BQ item with site photos (D6.3): one column for phones
 * (360 px), large inputs, a photo taken on the spot or chosen from the project's photos.
 * Offline-ready contract: the record's ID and the Idempotency-Key are generated once per form, so
 * a retried submit cannot record twice; a refusal that recorded nothing renews them.
 */
export function MeasurementForm({
  projectId,
  sites,
  initialItems,
  preselected,
  correction,
}: {
  projectId: string;
  sites: { id: string; name: string }[];
  initialItems: MeasurementItem[];
  preselected: string | null;
  correction: {
    id: string;
    lineageId: string;
    measuredOn: string;
    quantityToDate: string;
  } | null;
}) {
  const t = useTranslations("valuations.measure");
  const tBasis = useTranslations("valuations.basis");
  const problem = useValuationProblem();
  const router = useRouter();
  const today = nairobiDate();
  const [items, setItems] = useState(initialItems);
  const [search, setSearch] = useState("");
  const [lineageId, setLineageId] = useState(
    correction?.lineageId ??
      preselected ??
      initialItems.find((row) => row.basis)?.item.lineageId ??
      "",
  );
  const [measuredOn, setMeasuredOn] = useState(correction?.measuredOn ?? today);
  const [quantity, setQuantity] = useState(correction?.quantityToDate ?? "");
  const [overReason, setOverReason] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<QualityPhoto[]>([]);
  const [recent, setRecent] = useState<QualityPhoto[]>([]);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ids = useRef({ id: crypto.randomUUID(), key: crypto.randomUUID() });

  useEffect(() => {
    liveRequest(`/projects/${projectId}/photos?limit=12`, sitePhotosResponseSchema)
      .then((result) =>
        setRecent(
          result.photos.map((photo) => ({
            id: photo.id,
            verified: photo.verified,
            caption: photo.caption,
          })),
        ),
      )
      .catch(() => setRecent([]));
  }, [projectId]);

  useEffect(() => {
    const needle = search.trim();
    if (!needle) return;
    const timer = setTimeout(() => {
      liveRequest(
        `/projects/${projectId}/measurements/items?limit=50&search=${encodeURIComponent(needle)}`,
        measurementItemsResponseSchema,
      )
        .then((result) => setItems(result.items))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [projectId, search]);

  const selected = useMemo(
    () =>
      items.find((row) => row.item.lineageId === lineageId) ??
      initialItems.find((row) => row.item.lineageId === lineageId) ??
      null,
    [items, initialItems, lineageId],
  );
  const percent = selected?.basis === "percent";
  const parsed = parseQuantityInput(quantity, percent);
  const over = Boolean(
    parsed && selected?.basis === "quantity" && exceedsQuantity(parsed, selected.quantity),
  );
  const valid =
    Boolean(selected?.basis) &&
    parsed !== null &&
    /^\d{4}-\d{2}-\d{2}$/.test(measuredOn) &&
    measuredOn <= today &&
    (!over || Array.from(overReason.trim()).length >= 3) &&
    (!correction || Array.from(correctionReason.trim()).length >= 3);

  async function save() {
    if (!selected || !parsed) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await liveRequest(
        `/projects/${projectId}/measurements`,
        measurementResponseSchema,
        {
          method: "POST",
          body: {
            id: ids.current.id,
            bqItemLineageId: selected.item.lineageId,
            measuredOn,
            quantityToDate: parsed,
            note: note.trim() || null,
            ...(over ? { overMeasureReason: overReason.trim() } : {}),
            ...(correction
              ? { correctsMeasurementId: correction.id, correctionReason: correctionReason.trim() }
              : {}),
            photoIds: photos.map((photo) => photo.id),
          },
          headers: { "Idempotency-Key": ids.current.key },
        },
      );
      router.push(
        `/valuations/projects/${projectId}/measurements/${result.measurement.id}?recorded=1`,
      );
    } catch (error) {
      if (
        error instanceof FoundationApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.code !== "idempotency-key-reused" &&
        error.code !== "measurement-id-conflict"
      )
        ids.current = { id: crypto.randomUUID(), key: crypto.randomUUID() };
      setFailure(problem(error));
      setBusy(false);
    }
  }

  const choose = (photo: QualityPhoto) =>
    setPhotos((current) =>
      current.some((entry) => entry.id === photo.id) || current.length >= MAX_PHOTOS
        ? current
        : [...current, photo],
    );

  return (
    <form
      className="max-w-xl space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {correction ? (
        <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          {t("correctionNote", { quantity: correction.quantityToDate })}
        </p>
      ) : (
        <Field>
          <FieldLabel htmlFor="measure-search">{t("search")}</FieldLabel>
          <Input
            id="measure-search"
            type="search"
            className="h-11 text-base sm:text-sm"
            value={search}
            maxLength={100}
            onChange={(event) => setSearch(event.target.value)}
          />
          <FieldDescription>{t("searchHint")}</FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="measure-item">{t("item")}</FieldLabel>
        <select
          id="measure-item"
          className={selectClass}
          value={lineageId}
          disabled={Boolean(correction)}
          onChange={(event) => {
            setLineageId(event.target.value);
            setQuantity("");
          }}
        >
          <option value="" disabled>
            {t("chooseItem")}
          </option>
          {items.map((row) => (
            <option key={row.item.lineageId} value={row.item.lineageId} disabled={!row.basis}>
              {itemLabel(row.item)} · {row.item.description.slice(0, 60)}
              {row.basis ? "" : ` (${t("notMeasured")})`}
            </option>
          ))}
        </select>
      </Field>
      {selected ? (
        <dl className="grid grid-cols-2 gap-2 rounded-xl border p-3 text-sm">
          <div>
            <dt className="text-muted-foreground">{t("basis")}</dt>
            <dd>{selected.basis ? tBasis(selected.basis) : t("notMeasured")}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("bqQuantity")}</dt>
            <dd className="tabular-nums">
              {selected.quantity
                ? `${formatDecimalString(selected.quantity)} ${selected.item.unit ?? ""}`
                : formatKES(selected.amountMinor)}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">{t("approvedToDate")}</dt>
            <dd className="tabular-nums">
              {selected.approved
                ? t("approvedLine", {
                    quantity: formatDecimalString(selected.approved.quantityToDate),
                    date: formatCalendarDate(selected.approved.measuredOn),
                    percent: selected.approved.percentComplete ?? "—",
                  })
                : t("noneApproved")}
            </dd>
          </div>
        </dl>
      ) : null}
      <Field>
        <FieldLabel htmlFor="measure-date">{t("date")}</FieldLabel>
        <Input
          id="measure-date"
          type="date"
          className="h-11 text-base sm:text-sm"
          value={measuredOn}
          max={today}
          disabled={Boolean(correction)}
          onChange={(event) => setMeasuredOn(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="measure-quantity">
          {percent ? t("percent") : t("quantity", { unit: selected?.item.unit ?? "" })}
        </FieldLabel>
        <Input
          id="measure-quantity"
          inputMode="decimal"
          autoComplete="off"
          className="h-11 text-base sm:text-sm"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          aria-invalid={quantity.trim() !== "" && parsed === null}
        />
        <FieldDescription>{percent ? t("percentHint") : t("quantityHint")}</FieldDescription>
      </Field>
      {over ? (
        <Field>
          <FieldLabel htmlFor="measure-over">{t("overReason")}</FieldLabel>
          <Textarea
            id="measure-over"
            rows={3}
            maxLength={500}
            value={overReason}
            onChange={(event) => setOverReason(event.target.value)}
          />
          <FieldDescription>{t("overHint")}</FieldDescription>
        </Field>
      ) : null}
      {correction ? (
        <Field>
          <FieldLabel htmlFor="measure-correction">{t("correctionReason")}</FieldLabel>
          <Textarea
            id="measure-correction"
            rows={3}
            maxLength={500}
            value={correctionReason}
            onChange={(event) => setCorrectionReason(event.target.value)}
          />
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor="measure-note">{t("note")}</FieldLabel>
        <Textarea
          id="measure-note"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      <fieldset className="space-y-3 rounded-xl border p-3">
        <legend className="px-1 text-sm font-medium">{t("photos")}</legend>
        <p className="text-sm text-muted-foreground">{t("photosHint")}</p>
        <PhotoThumbs
          projectId={projectId}
          photos={photos}
          label={t("chosenPhotos")}
          onRemove={(photoId) =>
            setPhotos((current) => current.filter((photo) => photo.id !== photoId))
          }
        />
        {sites.length > 1 ? (
          <Field>
            <FieldLabel htmlFor="measure-site">{t("site")}</FieldLabel>
            <select
              id="measure-site"
              className={selectClass}
              value={siteId}
              onChange={(event) => setSiteId(event.target.value)}
            >
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {siteId ? (
          <PhotoUpload
            projectId={projectId}
            siteId={siteId}
            caption={selected ? itemLabel(selected.item) : t("photoCaption")}
            label={t("takePhoto")}
            disabled={photos.length >= MAX_PHOTOS}
            onUploaded={(photo) => {
              choose(photo);
              setRecent((current) => [photo, ...current]);
            }}
          />
        ) : null}
        {recent.length ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("recentPhotos")}</p>
            <ul className="flex flex-wrap gap-2">
              {recent
                .filter((photo) => !photos.some((entry) => entry.id === photo.id))
                .map((photo, index) => (
                  <li key={photo.id}>
                    <button
                      type="button"
                      className="relative block overflow-hidden rounded-md border focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      onClick={() => choose(photo)}
                      disabled={photos.length >= MAX_PHOTOS}
                      aria-label={t("usePhoto", { index: index + 1 })}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated API image */}
                      <img
                        src={photoThumbnail(projectId, photo.id)}
                        alt=""
                        loading="lazy"
                        className="size-16 bg-muted object-cover"
                      />
                      {photo.verified ? (
                        <ShieldCheck
                          className="absolute bottom-1 left-1 size-4 rounded-full bg-background text-success"
                          aria-hidden
                        />
                      ) : null}
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
        {photos.length === 0 ? (
          <p className="text-sm text-warning-foreground dark:text-warning">{t("noPhotoYet")}</p>
        ) : null}
      </fieldset>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <div className="sticky bottom-0 -mx-1 bg-background/95 px-1 py-3 sm:static sm:bg-transparent">
        <Button type="submit" className="h-11 w-full sm:w-auto" disabled={busy || !valid}>
          {busy ? t("saving") : correction ? t("submitCorrection") : t("submit")}
        </Button>
      </div>
    </form>
  );
}
