"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef } from "react";
import type { LeafletEvent, Tooltip as LeafletTooltip } from "leaflet";
import { Circle, MapContainer, Polygon, Tooltip } from "react-leaflet";
import { MapChrome, shapeBounds, type GeofenceShape, type MapLabels } from "./map-shared";

export type MapFence = { id: string; name: string; geofence: GeofenceShape };

const style = { color: "#1d4ed8", weight: 2, dashArray: "6 4", fillOpacity: 0.12 };

/**
 * A permanent fence label. Leaflet inserts the tooltip element (role="tooltip") before React
 * renders the text into it, so the element is named from its first moment (axe
 * aria-tooltip-name); the name is the visible text, set as text, never as HTML.
 */
function FenceLabel({ name }: { name: string }) {
  const ref = useRef<LeafletTooltip>(null);
  const handlers = useMemo(
    () => ({
      add: (event: LeafletEvent) =>
        (event.target as LeafletTooltip).getElement()?.setAttribute("aria-label", name),
    }),
    [name],
  );
  useEffect(() => {
    ref.current?.getElement()?.setAttribute("aria-label", name);
  }, [name]);
  return (
    <Tooltip ref={ref} permanent direction="center" eventHandlers={handlers}>
      {name}
    </Tooltip>
  );
}

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
            <FenceLabel name={fence.name} />
          </Circle>
        ) : (
          <Polygon
            key={fence.id}
            positions={fence.geofence.vertices.map(
              (vertex) => [vertex.lat, vertex.lng] as [number, number],
            )}
            pathOptions={style}
          >
            <FenceLabel name={fence.name} />
          </Polygon>
        ),
      )}
    </MapContainer>
  );
}
