"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Camera, LocateFixed, RotateCcw } from "lucide-react";
import { normaliseVehicleRegistration } from "@pm-buddy/domain";
import {
  P2P_LIMITS,
  type GrnPhotoKind,
  type LocationError,
  type StandardUnitCode,
} from "@pm-buddy/types";
import {
  grnResponseSchema,
  procurementDocumentResponseSchema,
  type GrnResponse,
  type ReceivableLposResponse,
  type UnitWire,
} from "@pm-buddy/validation";
import { selectClass } from "@/components/procurement/material-form";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest, liveUpload } from "@/lib/live-api";
import {
  formatQuantity,
  isQuantity,
  locationTone,
  newClientId,
  quantityAbove,
  remainingQuantity,
  scaleQuantity,
} from "@/lib/p2p";
import { unitLabel } from "@/lib/procurement";
import { useP2pProblem } from "./use-p2p-problem";

type Receivable = ReceivableLposResponse["lpos"][number];
type LineInput = { received: string; unit: string; rejected: string; reason: string };
type Fix = { latitude: number; longitude: number; accuracyM: number };
type Located =
  | { state: "idle" }
  | { state: "locating" }
  | { state: "fixed"; fix: Fix }
  | { state: "failed"; error: LocationError };
type PendingPhoto = { kind: GrnPhotoKind; file: File };

const IMAGE_TYPES = "image/jpeg,image/png,image/webp";
const GEO_ERRORS: Record<number, LocationError> = { 1: "denied", 2: "unavailable", 3: "timeout" };
const blankLines = (lpo: Receivable | undefined) =>
  Object.fromEntries(
    (lpo?.lines ?? []).map((line) => [
      line.id,
      { received: "", unit: line.unit, rejected: "", reason: "" },
    ]),
  ) as Record<string, LineInput>;

/**
 * Mobile-first Goods Received Note capture (D5.2, brief §5.3 and §15 E). The GRN's ID and the
 * Idempotency-Key are generated once for this form, and the capture time is fixed at the first
 * attempt, so a double tap or a retry after a lost response replays the same delivery instead
 * of recording it twice. The browser's position (with its accuracy) is a claim checked against
 * the site geofence by the API; being outside or having no position is flagged, never blocking.
 * Photos are uploaded after the GRN exists; a failed upload leaves the GRN recorded with its
 * evidence marked incomplete and can be retried.
 */
export function GrnCapture({
  lpos,
  units,
  defaultLpoId,
  receivedByDefault,
}: {
  lpos: Receivable[];
  units: UnitWire[];
  defaultLpoId?: string;
  receivedByDefault: string;
}) {
  const t = useTranslations("p2p.grns.capture");
  const tStatus = useTranslations("p2p.status");
  const tCommon = useTranslations("p2p.common");
  const tUnits = useTranslations("catalogue.units");
  const problem = useP2pProblem();
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const initial = lpos.find((entry) => entry.id === defaultLpoId) ?? lpos[0];
  const [identity, setIdentity] = useState(() => ({ id: newClientId(), key: newClientId() }));
  const capturedAt = useRef<string | null>(null);
  const sending = useRef(false);
  const [lpoId, setLpoId] = useState(initial?.id ?? "");
  const [siteId, setSiteId] = useState(initial?.deliverySite?.id ?? initial?.sites[0]?.id ?? "");
  const [lines, setLines] = useState<Record<string, LineInput>>(() => blankLines(initial));
  const [vehicle, setVehicle] = useState("");
  const [receivedBy, setReceivedBy] = useState(receivedByDefault);
  const [deliveryNote, setDeliveryNote] = useState("");
  const [notes, setNotes] = useState("");
  const [located, setLocated] = useState<Located>({ state: "idle" });
  const [photos, setPhotos] = useState<Record<GrnPhotoKind, File[]>>({
    delivery_note: [],
    goods: [],
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<GrnResponse | null>(null);
  const [failedPhotos, setFailedPhotos] = useState<{ photos: PendingPhoto[]; message: string }>({
    photos: [],
    message: "",
  });
  const [uploading, setUploading] = useState(false);

  const lpo = lpos.find((entry) => entry.id === lpoId);
  const plate = vehicle.trim() ? normaliseVehicleRegistration(vehicle) : null;
  const entered = (lpo?.lines ?? []).filter((line) => lines[line.id]?.received.trim());
  const lineIssues = entered.map((line) => {
    const input = lines[line.id]!;
    const received = input.received.trim();
    const rejected = input.rejected.trim() || "0";
    if (!isQuantity(received) || !isQuantity(rejected)) return "invalid";
    if (quantityAbove(rejected, received)) return "rejectedAbove";
    if (quantityAbove(rejected, "0") && input.reason.trim().length < 1) return "reason";
    return null;
  });
  const anything = entered.some((line) => /[1-9]/.test(lines[line.id]!.received));
  const valid =
    Boolean(lpo) &&
    anything &&
    lineIssues.every((issue) => issue === null) &&
    plate !== null &&
    receivedBy.trim().length >= 2;

  /** Accepted now in the base unit, when the client can convert exactly (line or base unit). */
  const acceptedBase = (line: Receivable["lines"][number], input: LineInput) => {
    const received = input.received.trim();
    const rejected = input.rejected.trim() || "0";
    if (!isQuantity(received) || !isQuantity(rejected) || quantityAbove(rejected, received))
      return null;
    const accepted = remainingQuantity(received, rejected);
    if (input.unit === line.material.baseUnit) return accepted;
    if (input.unit === line.unit) return scaleQuantity(accepted, line.baseQuantity, line.quantity);
    return null;
  };

  function chooseLpo(id: string) {
    const next = lpos.find((entry) => entry.id === id);
    setLpoId(id);
    setSiteId(next?.deliverySite?.id ?? next?.sites[0]?.id ?? "");
    setLines(blankLines(next));
  }

  function locate() {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setLocated({ state: "failed", error: "unsupported" });
      return;
    }
    setLocated({ state: "locating" });
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setLocated({
          state: "fixed",
          fix: {
            latitude: Math.round(position.coords.latitude * 1e6) / 1e6,
            longitude: Math.round(position.coords.longitude * 1e6) / 1e6,
            accuracyM: Math.min(100_000, Math.round(position.coords.accuracy * 10) / 10),
          },
        }),
      (error) => setLocated({ state: "failed", error: GEO_ERRORS[error.code] ?? "unavailable" }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 30_000 },
    );
  }

  async function uploadPhotos(id: string, pending: PendingPhoto[]) {
    setUploading(true);
    const failed: PendingPhoto[] = [];
    let message = "";
    for (const photo of pending) {
      try {
        await liveUpload(
          `/procurement/grns/${id}/photos?kind=${photo.kind}`,
          photo.file,
          procurementDocumentResponseSchema,
        );
      } catch (error) {
        failed.push(photo);
        message = problem(error);
      }
    }
    setFailedPhotos({ photos: failed, message });
    setUploading(false);
  }

  async function submit() {
    if (!lpo || sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    capturedAt.current ??= new Date().toISOString();
    try {
      const response = await liveRequest("/procurement/grns", grnResponseSchema, {
        method: "POST",
        headers: { "Idempotency-Key": identity.key },
        body: {
          id: identity.id,
          lpoId: lpo.id,
          siteId: siteId || null,
          capturedAt: capturedAt.current,
          receivedByName: receivedBy.trim(),
          vehicleRegistration: vehicle,
          deliveryNoteNumber: deliveryNote.trim() || null,
          location: located.state === "fixed" ? located.fix : null,
          locationError: located.state === "failed" ? located.error : null,
          notes: notes.trim() || null,
          source: "web",
          lines: entered.map((line) => {
            const input = lines[line.id]!;
            const rejected = input.rejected.trim() || "0";
            return {
              lpoLineId: line.id,
              unit: input.unit,
              receivedQuantity: input.received.trim(),
              rejectedQuantity: rejected,
              rejectionReason: /[1-9]/.test(rejected) ? input.reason.trim() : null,
            };
          }),
        },
      });
      setResult(response);
      const pending: PendingPhoto[] = [
        ...photos.delivery_note.map((file) => ({ kind: "delivery_note" as const, file })),
        ...photos.goods.map((file) => ({ kind: "goods" as const, file })),
      ];
      // A replay means the first response was lost before any photo was sent: send them now.
      if (pending.length) await uploadPhotos(response.grn.id, pending);
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
    setFailedPhotos({ photos: [], message: "" });
    setLines(blankLines(lpo));
    setVehicle("");
    setDeliveryNote("");
    setNotes("");
    setPhotos({ delivery_note: [], goods: [] });
    setLocated({ state: "idle" });
  }

  if (!lpos.length) return <p className="text-sm text-muted-foreground">{t("noLpos")}</p>;

  if (result) {
    const { grn } = result;
    const evidenceWaiting = failedPhotos.photos.length > 0 || uploading;
    return (
      <section
        aria-labelledby="grn-result"
        className="space-y-3 rounded-xl border p-4"
        data-testid="grn-result"
      >
        <h2 id="grn-result" className="text-lg font-semibold" role="status">
          {result.replayed
            ? t("replayed", { number: grn.number })
            : t("recorded", { number: grn.number })}
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {t("geofenceResult", { state: tStatus(`location.${grn.location.state}`) })}
          <StatusBadge tone={locationTone[grn.location.state]}>
            {tStatus(`location.${grn.location.state}`)}
          </StatusBadge>
          {grn.location.lowAccuracy ? (
            <StatusBadge tone="warning">{t("lowAccuracy")}</StatusBadge>
          ) : null}
          {grn.overDelivery ? (
            <StatusBadge tone="warning">{tStatus("delivery.over")}</StatusBadge>
          ) : null}
          <StatusBadge tone={grn.vehicleRegistrationFormat === "kenyan" ? "neutral" : "warning"}>
            {tStatus(`vehicle.${grn.vehicleRegistrationFormat}`)}
          </StatusBadge>
        </p>
        {evidenceWaiting ? <p className="text-sm">{t("evidencePending")}</p> : null}
        {failedPhotos.photos.length ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-destructive">
              {t("photosFailed", {
                count: failedPhotos.photos.length,
                message: failedPhotos.message,
              })}
            </p>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={uploading}
              onClick={() => void uploadPhotos(grn.id, failedPhotos.photos)}
            >
              <RotateCcw aria-hidden /> {t("retryPhotos")}
            </Button>
          </div>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild className="h-11">
            <Link href={`/procurement/grns/${grn.id}`}>{t("open", { number: grn.number })}</Link>
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
        if (valid) void submit();
      }}
    >
      <Field>
        <FieldLabel htmlFor="grn-lpo">{t("lpo")}</FieldLabel>
        <select
          id="grn-lpo"
          className={`${selectClass} h-11`}
          value={lpoId}
          onChange={(event) => chooseLpo(event.target.value)}
        >
          {lpos.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {t("lpoLabel", { number: entry.number, supplier: entry.supplier.name })}
            </option>
          ))}
        </select>
        {lpo ? (
          <FieldDescription>
            {lpo.project.code} · {lpo.project.name}
          </FieldDescription>
        ) : null}
      </Field>
      {lpo && lpo.sites.length ? (
        <Field>
          <FieldLabel htmlFor="grn-site">{t("site")}</FieldLabel>
          <select
            id="grn-site"
            className={`${selectClass} h-11`}
            value={siteId}
            onChange={(event) => setSiteId(event.target.value)}
          >
            {lpo.sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t("lines")}</legend>
        {(lpo?.lines ?? []).map((line) => {
          const input = lines[line.id] ?? {
            received: "",
            unit: line.unit,
            rejected: "",
            reason: "",
          };
          const set = (patch: Partial<LineInput>) =>
            setLines((current) => ({ ...current, [line.id]: { ...input, ...patch } }));
          const accepted = acceptedBase(line, input);
          const expected = remainingQuantity(line.baseQuantity, line.receivedBaseQuantity);
          const over = accepted !== null && quantityAbove(accepted, expected);
          const rejectedSome = /[1-9]/.test(input.rejected);
          const unitOptions = [...new Set([line.unit, line.material.baseUnit])];
          const id = `grn-line-${line.lineNo}`;
          return (
            <div
              key={line.id}
              className="space-y-2 rounded-lg border p-3"
              role="group"
              aria-labelledby={`${id}-name`}
            >
              <p id={`${id}-name`} className="font-medium">
                {line.material.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("ordered", {
                  quantity: `${formatQuantity(line.quantity)} ${label(line.unit)}`,
                })}{" "}
                ·{" "}
                {t("alreadyReceived", {
                  quantity: `${formatQuantity(line.receivedBaseQuantity)} ${label(line.material.baseUnit)}`,
                })}
              </p>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Field>
                  <FieldLabel htmlFor={`${id}-received`}>{t("received")}</FieldLabel>
                  <Input
                    id={`${id}-received`}
                    inputMode="decimal"
                    className="h-11 text-base"
                    value={input.received}
                    aria-invalid={input.received !== "" && !isQuantity(input.received.trim())}
                    onChange={(event) => set({ received: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-unit`}>{tCommon("unit")}</FieldLabel>
                  <select
                    id={`${id}-unit`}
                    className={`${selectClass} h-11`}
                    value={input.unit}
                    onChange={(event) => set({ unit: event.target.value })}
                  >
                    {unitOptions.map((unit) => (
                      <option key={unit} value={unit}>
                        {label(unit)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`${id}-rejected`}>{t("rejected")}</FieldLabel>
                  <Input
                    id={`${id}-rejected`}
                    inputMode="decimal"
                    className="h-11 text-base"
                    value={input.rejected}
                    onChange={(event) => set({ rejected: event.target.value })}
                  />
                </Field>
                {rejectedSome ? (
                  <Field>
                    <FieldLabel htmlFor={`${id}-reason`}>{t("rejectionReason")}</FieldLabel>
                    <Input
                      id={`${id}-reason`}
                      className="h-11 text-base"
                      maxLength={300}
                      value={input.reason}
                      onChange={(event) => set({ reason: event.target.value })}
                    />
                  </Field>
                ) : null}
              </div>
              {over ? (
                <p className="text-sm text-warning-foreground dark:text-warning" role="status">
                  {t("overDelivery")}
                </p>
              ) : null}
            </div>
          );
        })}
      </fieldset>

      <Field>
        <FieldLabel htmlFor="grn-vehicle">{t("vehicle")}</FieldLabel>
        <Input
          id="grn-vehicle"
          className="h-11 text-base uppercase"
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={20}
          value={vehicle}
          aria-describedby="grn-vehicle-hint grn-vehicle-check"
          onChange={(event) => setVehicle(event.target.value)}
        />
        <FieldDescription id="grn-vehicle-hint">{t("vehicleHint")}</FieldDescription>
        {vehicle.trim() ? (
          <p id="grn-vehicle-check" className="text-sm" role="status">
            {plate
              ? plate.format === "kenyan"
                ? t("vehicleKenyan", { value: plate.value })
                : t("vehicleOther", { value: plate.value })
              : t("vehicleInvalid")}
          </p>
        ) : null}
      </Field>
      <Field>
        <FieldLabel htmlFor="grn-received-by">{t("receivedBy")}</FieldLabel>
        <Input
          id="grn-received-by"
          className="h-11 text-base"
          maxLength={100}
          value={receivedBy}
          onChange={(event) => setReceivedBy(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="grn-delivery-note">{t("deliveryNote")}</FieldLabel>
        <Input
          id="grn-delivery-note"
          className="h-11 text-base"
          maxLength={60}
          value={deliveryNote}
          onChange={(event) => setDeliveryNote(event.target.value)}
        />
      </Field>

      <section aria-labelledby="grn-location" className="space-y-2">
        <h2 id="grn-location" className="text-base font-semibold">
          {t("location")}
        </h2>
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full sm:w-auto"
          disabled={located.state === "locating"}
          onClick={locate}
        >
          <LocateFixed aria-hidden />{" "}
          {located.state === "locating"
            ? t("locating")
            : located.state === "fixed"
              ? t("locateAgain")
              : t("locate")}
        </Button>
        <div role="status" className="text-sm">
          {located.state === "fixed" ? (
            <>
              <p>
                {t("position", {
                  accuracy: String(located.fix.accuracyM),
                  lat: String(located.fix.latitude),
                  lng: String(located.fix.longitude),
                })}
              </p>
              {located.fix.accuracyM > P2P_LIMITS.gpsMaxAccuracyM ? (
                <p className="text-warning-foreground dark:text-warning">{t("lowAccuracy")}</p>
              ) : null}
            </>
          ) : located.state === "failed" ? (
            <p>{tStatus(`locationError.${located.error}`)}</p>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{t("locationNote")}</p>
      </section>

      <section aria-labelledby="grn-photos" className="space-y-3">
        <h2 id="grn-photos" className="text-base font-semibold">
          {t("photos")}
        </h2>
        {(["delivery_note", "goods"] as const).map((kind) => (
          <Field key={kind}>
            <FieldLabel htmlFor={`grn-photo-${kind}`}>
              <Camera className="inline size-4" aria-hidden />{" "}
              {kind === "delivery_note" ? t("deliveryNotePhoto") : t("goodsPhoto")}
            </FieldLabel>
            <input
              id={`grn-photo-${kind}`}
              type="file"
              accept={IMAGE_TYPES}
              capture="environment"
              multiple
              className="max-w-full text-sm file:mr-2 file:h-11 file:rounded-md file:border file:bg-background file:px-3"
              onChange={(event) =>
                setPhotos((current) => ({
                  ...current,
                  [kind]: Array.from(event.target.files ?? []),
                }))
              }
            />
            <FieldDescription>
              {t("selected", { count: photos[kind].length })} · {t("photoHint")}
            </FieldDescription>
          </Field>
        ))}
      </section>

      <Field>
        <FieldLabel htmlFor="grn-notes">{tCommon("notesOptional")}</FieldLabel>
        <Textarea
          id="grn-notes"
          rows={2}
          maxLength={1000}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </Field>

      {!anything ? <p className="text-sm text-muted-foreground">{t("nothing")}</p> : null}
      {lineIssues.includes("reason") ? (
        <p className="text-sm text-destructive">{t("rejectionNeeded")}</p>
      ) : null}
      {lineIssues.includes("rejectedAbove") ? (
        <p className="text-sm text-destructive">{t("rejectedAbove")}</p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <Button type="submit" className="h-12 w-full text-base sm:w-auto" disabled={busy || !valid}>
        {busy ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
