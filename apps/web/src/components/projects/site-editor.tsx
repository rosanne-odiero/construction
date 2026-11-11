"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Plus, Trash2, Undo2 } from "lucide-react";
import {
  GEOFENCE_LIMITS,
  geofenceMetrics,
  normaliseGeofence,
  roundCoordinate,
  validateGeofence,
  type Geofence,
  type LatLng,
} from "@pm-buddy/domain";
import { siteResponseSchema, type Site } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TILES_ENABLED } from "@/components/maps/tiles";
import type { EditorShape } from "@/components/maps/geofence-editor-map";
import { formatArea, formatLength } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { useProblemMessage } from "./use-problem-message";

const GeofenceEditorMap = dynamic(() => import("@/components/maps/geofence-editor-map"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

type State = { polygon: LatLng[]; center: LatLng | null; radiusM: number; kind: Geofence["kind"] };
const HISTORY_LIMIT = 50;
const METRE = 1 / 111_195;

function initialState(site: Site | null, fallback: LatLng): State {
  const shape = site?.geofence.geofence;
  if (shape?.kind === "polygon")
    return { kind: "polygon", polygon: shape.vertices, center: null, radiusM: 100 };
  if (shape?.kind === "radius")
    return { kind: "radius", polygon: [], center: shape.center, radiusM: shape.radiusM };
  return { kind: "polygon", polygon: [], center: fallback, radiusM: 100 };
}

const round = (point: LatLng): LatLng => ({
  lat: roundCoordinate(point.lat),
  lng: roundCoordinate(point.lng),
});

/** A coordinate text box that keeps the user's partial input until it parses as a number. */
function CoordinateInput({
  id,
  label,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  value: number | null;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const [synced, setSynced] = useState(value);
  // Follow changes made elsewhere (map, undo) without overwriting what the user is typing.
  if (value !== synced) {
    setSynced(value);
    if (Number(text.replace("\u2212", "-")) !== value) setText(value === null ? "" : String(value));
  }
  return (
    <Input
      id={id}
      aria-label={label}
      inputMode="decimal"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = Number(event.target.value.replace("\u2212", "-"));
        if (event.target.value.trim() !== "" && Number.isFinite(parsed))
          onCommit(roundCoordinate(parsed));
      }}
      className="h-8 font-mono text-xs"
    />
  );
}

/**
 * Site geofence editor (D2.1): draw a polygon by clicking vertices (drag to move, select and
 * delete, undo) or set a radius with a centre and slider. The coordinate list is the keyboard
 * alternative to the map and edits the same state. Validation uses the shared domain rules, so
 * the editor shows exactly what the API will accept.
 */
export function SiteEditor({
  projectId,
  site,
  fallbackCenter,
}: {
  projectId: string;
  /** The site whose geofence is being changed; null adds a new site. */
  site: Site | null;
  fallbackCenter: LatLng;
}) {
  const t = useTranslations("sites.editor");
  const tKind = useTranslations("sites.kind");
  const tIssues = useTranslations("sites.issues");
  const problem = useProblemMessage();
  const router = useRouter();
  const [state, setState] = useState<State>(() => initialState(site, fallbackCenter));
  const [history, setHistory] = useState<State[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  const change = (next: (current: State) => State) => {
    setHistory((past) => [...past.slice(-HISTORY_LIMIT + 1), state]);
    setState(next);
  };
  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory(history.slice(0, -1));
    setState(previous);
    setSelected(null);
  };

  const geofence: Geofence | null = useMemo(() => {
    if (state.kind === "polygon")
      return normaliseGeofence({ kind: "polygon", vertices: state.polygon });
    return state.center
      ? normaliseGeofence({ kind: "radius", center: state.center, radiusM: state.radiusM })
      : null;
  }, [state]);
  const issues = geofence ? validateGeofence(geofence) : (["too_few_vertices"] as const);
  // Saving an unchanged geofence would only add an identical version.
  const unchanged =
    site !== null && JSON.stringify(geofence) === JSON.stringify(site.geofence.geofence);
  const metrics = geofence && !issues.length ? geofenceMetrics(geofence) : null;
  const shape: EditorShape =
    state.kind === "polygon"
      ? { kind: "polygon", vertices: state.polygon }
      : { kind: "radius", center: state.center, radiusM: state.radiusM };

  function addVertex(point?: LatLng) {
    change((current) => {
      const vertices = current.polygon;
      let next = point;
      if (!next) {
        const last = vertices.at(-1);
        const first = vertices[0];
        if (!last) next = fallbackCenter;
        else if (vertices.length === 1) next = { lat: last.lat, lng: last.lng + 30 * METRE };
        else if (vertices.length === 2) next = { lat: last.lat + 30 * METRE, lng: last.lng };
        else next = { lat: (last.lat + first!.lat) / 2, lng: (last.lng + first!.lng) / 2 };
      }
      return { ...current, polygon: [...vertices, round(next)] };
    });
  }
  const moveVertex = (index: number, point: LatLng) =>
    change((current) => ({
      ...current,
      polygon: current.polygon.map((vertex, i) => (i === index ? round(point) : vertex)),
    }));
  const removeVertex = (index: number) => {
    change((current) => ({ ...current, polygon: current.polygon.filter((_, i) => i !== index) }));
    setSelected(null);
  };
  const reorder = (index: number, offset: -1 | 1) =>
    change((current) => {
      const vertices = [...current.polygon];
      const target = index + offset;
      if (target < 0 || target >= vertices.length) return current;
      [vertices[index], vertices[target]] = [vertices[target]!, vertices[index]!];
      return { ...current, polygon: vertices };
    });

  async function save() {
    setAttempted(true);
    if (!geofence || issues.length || (!site && !name.trim())) return;
    setBusy(true);
    setFailure(null);
    try {
      if (site)
        await liveRequest(`/projects/${projectId}/sites/${site.id}/geofence`, siteResponseSchema, {
          method: "PUT",
          body: { geofence, currentVersion: site.geofence.version },
        });
      else
        await liveRequest(`/projects/${projectId}/sites`, siteResponseSchema, {
          method: "POST",
          body: {
            name: name.trim(),
            ...(address.trim() ? { address: address.trim() } : {}),
            geofence,
          },
        });
      router.push(`/projects/${projectId}?tab=sites`);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {failure ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {failure}
        </p>
      ) : null}
      {!site ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="site-name">
              {t("name")}
              <span aria-hidden> *</span>
            </FieldLabel>
            <Input
              id="site-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
              aria-invalid={attempted && !name.trim() ? true : undefined}
            />
            {attempted && !name.trim() ? (
              <p role="alert" className="text-sm text-destructive">
                {t("nameRequired")}
              </p>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="site-address">{t("address")}</FieldLabel>
            <Input
              id="site-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              maxLength={250}
            />
          </Field>
        </div>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("shape")}</legend>
        <div className="flex flex-wrap gap-4">
          {(["polygon", "radius"] as const).map((kind) => (
            <label key={kind} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="geofence-kind"
                value={kind}
                checked={state.kind === kind}
                onChange={() =>
                  change((current) => ({
                    ...current,
                    kind,
                    center: current.center ?? fallbackCenter,
                  }))
                }
                className="size-4 accent-primary"
              />
              {tKind(kind)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-3">
          <div
            role="region"
            aria-label={t("mapLabel")}
            aria-describedby="map-help"
            className="h-96 w-full overflow-hidden rounded-lg border"
          >
            <GeofenceEditorMap
              shape={shape}
              selected={selected}
              initialCenter={state.center ?? state.polygon[0] ?? fallbackCenter}
              labels={{ zoomIn: t("zoomIn"), zoomOut: t("zoomOut") }}
              vertexLabel={(number) => t("vertex", { number })}
              onAdd={(point) => {
                if (state.kind === "polygon") addVertex(point);
                else change((current) => ({ ...current, center: round(point) }));
              }}
              onMove={(index, point) => {
                if (state.kind === "polygon") moveVertex(index, point);
                else change((current) => ({ ...current, center: round(point) }));
              }}
              onSelect={setSelected}
            />
          </div>
          <p id="map-help" className="text-sm text-muted-foreground">
            {state.kind === "polygon" ? t("mapHelpPolygon") : t("mapHelpRadius")}{" "}
            {TILES_ENABLED ? null : t("tilesDisabled")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={undo}
              disabled={!history.length}
            >
              <Undo2 aria-hidden /> {t("undo")}
            </Button>
            {state.kind === "polygon" ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={selected === null}
                  onClick={() => selected !== null && removeVertex(selected)}
                >
                  <Trash2 aria-hidden /> {t("deleteVertex")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!state.polygon.length}
                  onClick={() => {
                    change((current) => ({ ...current, polygon: [] }));
                    setSelected(null);
                  }}
                >
                  {t("clear")}
                </Button>
              </>
            ) : null}
          </div>
          <p aria-live="polite" className="text-sm">
            {selected !== null && state.kind === "polygon"
              ? t("selected", { number: selected + 1 })
              : null}
          </p>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{t("coordinatesTitle")}</h2>
              </CardTitle>
              <p className="text-sm text-muted-foreground">{t("coordinatesHint")}</p>
            </CardHeader>
            <CardContent className="space-y-3">
              {state.kind === "polygon" ? (
                <>
                  {state.polygon.length ? (
                    <ol className="space-y-2">
                      {state.polygon.map((vertex, index) => {
                        const number = index + 1;
                        return (
                          <li
                            key={index}
                            className={`rounded-md border p-2 ${selected === index ? "border-amber-700" : ""}`}
                          >
                            <p className="mb-1 text-xs font-medium">{t("vertex", { number })}</p>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="w-28">
                                <CoordinateInput
                                  id={`vertex-${number}-lat`}
                                  label={t("vertexLatitude", { number })}
                                  value={vertex.lat}
                                  onCommit={(lat) => moveVertex(index, { ...vertex, lat })}
                                />
                              </div>
                              <div className="w-28">
                                <CoordinateInput
                                  id={`vertex-${number}-lng`}
                                  label={t("vertexLongitude", { number })}
                                  value={vertex.lng}
                                  onCommit={(lng) => moveVertex(index, { ...vertex, lng })}
                                />
                              </div>
                              <div className="flex gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t("moveUp", { number })}
                                  disabled={index === 0}
                                  onClick={() => reorder(index, -1)}
                                >
                                  <ArrowUp aria-hidden />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t("moveDown", { number })}
                                  disabled={index === state.polygon.length - 1}
                                  onClick={() => reorder(index, 1)}
                                >
                                  <ArrowDown aria-hidden />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t("remove", { number })}
                                  onClick={() => removeVertex(index)}
                                >
                                  <Trash2 aria-hidden />
                                </Button>
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("noVertices")}</p>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={state.polygon.length >= GEOFENCE_LIMITS.maxVertices}
                    onClick={() => addVertex()}
                  >
                    <Plus aria-hidden /> {t("addVertex")}
                  </Button>
                </>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="centre-lat">{t("centreLatitude")}</FieldLabel>
                    <CoordinateInput
                      id="centre-lat"
                      label={t("centreLatitude")}
                      value={state.center?.lat ?? null}
                      onCommit={(lat) =>
                        change((current) => ({
                          ...current,
                          center: { lat, lng: current.center?.lng ?? fallbackCenter.lng },
                        }))
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="centre-lng">{t("centreLongitude")}</FieldLabel>
                    <CoordinateInput
                      id="centre-lng"
                      label={t("centreLongitude")}
                      value={state.center?.lng ?? null}
                      onCommit={(lng) =>
                        change((current) => ({
                          ...current,
                          center: { lat: current.center?.lat ?? fallbackCenter.lat, lng },
                        }))
                      }
                    />
                  </Field>
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="radius-metres">{t("radiusMetres")}</FieldLabel>
                    <Input
                      id="radius-metres"
                      type="number"
                      min={GEOFENCE_LIMITS.minRadiusM}
                      max={GEOFENCE_LIMITS.maxRadiusM}
                      step={1}
                      value={state.radiusM}
                      onChange={(event) =>
                        change((current) => ({
                          ...current,
                          radiusM: Math.round(Number(event.target.value)),
                        }))
                      }
                    />
                    <input
                      type="range"
                      aria-label={t("radiusSlider")}
                      min={GEOFENCE_LIMITS.minRadiusM}
                      max={GEOFENCE_LIMITS.maxRadiusM}
                      step={5}
                      value={state.radiusM}
                      onChange={(event) =>
                        change((current) => ({ ...current, radiusM: Number(event.target.value) }))
                      }
                      className="w-full accent-primary"
                    />
                    <FieldDescription>{t("radiusHint")}</FieldDescription>
                  </Field>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{t("metrics")}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">{t("area")}</dt>
                  <dd className="font-medium tabular-nums" data-testid="geofence-area">
                    {metrics ? formatArea(metrics.areaM2) : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("perimeter")}</dt>
                  <dd className="font-medium tabular-nums" data-testid="geofence-perimeter">
                    {metrics ? formatLength(metrics.perimeterM) : "—"}
                  </dd>
                </div>
              </dl>
              <div aria-live="polite">
                {issues.length ? (
                  <div className="space-y-1 text-sm">
                    <p className="font-medium">{t("issuesTitle")}</p>
                    <ul className="list-disc pl-5 text-destructive">
                      {issues.map((issue) => (
                        <li key={issue}>{tIssues(issue)}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-sm text-success">{t("valid")}</p>
                )}
              </div>
              {site ? (
                <p className="text-xs text-muted-foreground">
                  {t("versionNote", { version: site.geofence.version + 1 })}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push(`/projects/${projectId}?tab=sites`)}
        >
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={busy || issues.length > 0 || unchanged}>
          {site ? t("saveGeofence") : t("save")}
        </Button>
      </div>
    </form>
  );
}
