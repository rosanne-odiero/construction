"use client";

import { AttributionControl, TileLayer, ZoomControl } from "react-leaflet";
import type { LatLngBoundsExpression } from "leaflet";
import type { GeofenceVersion } from "@pm-buddy/validation";
import { TILES_ENABLED } from "./tiles";

export type GeofenceShape = GeofenceVersion["geofence"];
export type MapLabels = { zoomIn: string; zoomOut: string };

const DEGREE_M = 111_195;

/** South-west and north-east corners around every shape. */
export function shapeBounds(shapes: GeofenceShape[]): LatLngBoundsExpression | null {
  const points: [number, number][] = [];
  for (const shape of shapes) {
    if (shape.kind === "polygon") {
      for (const vertex of shape.vertices) points.push([vertex.lat, vertex.lng]);
    } else {
      const dLat = shape.radiusM / DEGREE_M;
      const dLng = shape.radiusM / (DEGREE_M * Math.cos((shape.center.lat * Math.PI) / 180));
      points.push([shape.center.lat - dLat, shape.center.lng - dLng]);
      points.push([shape.center.lat + dLat, shape.center.lng + dLng]);
    }
  }
  if (!points.length) return null;
  const lats = points.map((point) => point[0]);
  const lngs = points.map((point) => point[1]);
  return [
    [Math.min(...lats), Math.min(...lngs)],
    [Math.max(...lats), Math.max(...lngs)],
  ];
}

/** Translated zoom buttons, the OSM layer (development only) and an attribution without tooltips. */
export function MapChrome({ labels }: { labels: MapLabels }) {
  return (
    <>
      <ZoomControl position="topleft" zoomInTitle={labels.zoomIn} zoomOutTitle={labels.zoomOut} />
      <AttributionControl
        position="bottomright"
        prefix='<a href="https://leafletjs.com">Leaflet</a>'
      />
      {TILES_ENABLED ? (
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
      ) : null}
    </>
  );
}
