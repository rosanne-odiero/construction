"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef } from "react";
import L, { type LatLngBoundsExpression } from "leaflet";
import {
  Circle,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type { LatLng } from "@pm-buddy/domain";
import { MapChrome, shapeBounds, type MapLabels } from "./map-shared";

export type EditorShape =
  | { kind: "polygon"; vertices: LatLng[] }
  | { kind: "radius"; center: LatLng | null; radiusM: number };

const vertexIcon = (selected: boolean, number: number) =>
  L.divIcon({
    className: "",
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    html: `<span class="flex size-[22px] items-center justify-center rounded-full border-2 border-white text-[10px] font-semibold text-white shadow ${
      selected ? "bg-amber-700" : "bg-blue-700"
    }">${number}</span>`,
  });
const centreIcon = L.divIcon({
  className: "",
  iconSize: [18, 18],
  iconAnchor: [9, 9],
  html: '<span class="block size-[18px] rounded-full border-2 border-white bg-blue-700 shadow"></span>',
});
const style = { color: "#1d4ed8", weight: 2, fillOpacity: 0.15 };

function Clicks({ onClick }: { onClick: (point: LatLng) => void }) {
  useMapEvents({
    click(event) {
      onClick({ lat: event.latlng.lat, lng: event.latlng.lng });
    },
  });
  return null;
}

/** Fits the view to the shape once, when the editor opens. */
function FitOnce({ bounds }: { bounds: LatLngBoundsExpression | null }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !bounds) return;
    done.current = true;
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 18 });
  }, [bounds, map]);
  return null;
}

/**
 * The pointer-driven half of the geofence editor: click to add a vertex or place the centre, drag
 * markers to move them, click a vertex to select it. Markers are not keyboard targets; the
 * coordinate list next to the map is the keyboard-accessible way to make every change.
 */
export default function GeofenceEditorMap({
  shape,
  selected,
  initialCenter,
  labels,
  vertexLabel,
  onAdd,
  onMove,
  onSelect,
}: {
  shape: EditorShape;
  selected: number | null;
  initialCenter: LatLng;
  labels: MapLabels;
  vertexLabel: (number: number) => string;
  onAdd: (point: LatLng) => void;
  onMove: (index: number, point: LatLng) => void;
  onSelect: (index: number) => void;
}) {
  const initialBounds = useMemo(
    () =>
      shapeBounds(
        shape.kind === "polygon"
          ? shape.vertices.length
            ? [{ kind: "polygon", vertices: shape.vertices }]
            : []
          : shape.center
            ? [{ kind: "radius", center: shape.center, radiusM: shape.radiusM }]
            : [],
      ),
    // Only the opening shape decides the first view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const positions =
    shape.kind === "polygon" ? shape.vertices.map((v) => [v.lat, v.lng] as [number, number]) : [];

  return (
    <MapContainer
      center={[initialCenter.lat, initialCenter.lng]}
      zoom={17}
      zoomControl={false}
      attributionControl={false}
      doubleClickZoom={false}
      className="h-full w-full"
    >
      <MapChrome labels={labels} />
      <FitOnce bounds={initialBounds} />
      <Clicks onClick={onAdd} />
      {shape.kind === "polygon" ? (
        <>
          {positions.length >= 3 ? <Polygon positions={positions} pathOptions={style} /> : null}
          {positions.length === 2 ? <Polyline positions={positions} pathOptions={style} /> : null}
          {shape.vertices.map((vertex, index) => (
            <Marker
              key={index}
              position={[vertex.lat, vertex.lng]}
              icon={vertexIcon(selected === index, index + 1)}
              draggable
              keyboard={false}
              title={vertexLabel(index + 1)}
              eventHandlers={{
                click: () => onSelect(index),
                dragend: (event) => {
                  const point = (event.target as L.Marker).getLatLng();
                  onMove(index, { lat: point.lat, lng: point.lng });
                },
              }}
            />
          ))}
        </>
      ) : shape.center ? (
        <>
          <Circle
            center={[shape.center.lat, shape.center.lng]}
            radius={shape.radiusM}
            pathOptions={style}
          />
          <Marker
            position={[shape.center.lat, shape.center.lng]}
            icon={centreIcon}
            draggable
            keyboard={false}
            eventHandlers={{
              dragend: (event) => {
                const point = (event.target as L.Marker).getLatLng();
                onMove(0, { lat: point.lat, lng: point.lng });
              },
            }}
          />
        </>
      ) : null}
    </MapContainer>
  );
}
