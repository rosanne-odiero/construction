"use client";

import "leaflet/dist/leaflet.css";
import { Circle, MapContainer, Polygon, Tooltip } from "react-leaflet";
import { MapChrome, shapeBounds, type GeofenceShape, type MapLabels } from "./map-shared";

export type MapFence = { id: string; name: string; geofence: GeofenceShape };

const style = { color: "#1d4ed8", weight: 2, dashArray: "6 4", fillOpacity: 0.12 };

/** Read-only map of the current geofences of a project's sites. */
export default function GeofenceMapInner({
  fences,
  labels,
}: {
  fences: MapFence[];
  labels: MapLabels;
}) {
  const bounds = shapeBounds(fences.map((fence) => fence.geofence));
  return (
    <MapContainer
      {...(bounds
        ? { bounds, boundsOptions: { padding: [32, 32] } }
        : { center: [-1.286, 36.817] as [number, number], zoom: 11 })}
      scrollWheelZoom={false}
      zoomControl={false}
      attributionControl={false}
      className="h-full w-full"
    >
      <MapChrome labels={labels} />
      {fences.map((fence) =>
        fence.geofence.kind === "radius" ? (
          <Circle
            key={fence.id}
            center={[fence.geofence.center.lat, fence.geofence.center.lng]}
            radius={fence.geofence.radiusM}
            pathOptions={style}
          >
            <Tooltip permanent direction="center">
              {fence.name}
            </Tooltip>
          </Circle>
        ) : (
          <Polygon
            key={fence.id}
            positions={fence.geofence.vertices.map(
              (vertex) => [vertex.lat, vertex.lng] as [number, number],
            )}
            pathOptions={style}
          >
            <Tooltip permanent direction="center">
              {fence.name}
            </Tooltip>
          </Polygon>
        ),
      )}
    </MapContainer>
  );
}
