"use client";

import "leaflet/dist/leaflet.css";
import { Circle, CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";
import type { LatLngBoundsExpression } from "leaflet";

export interface MapSite {
  id: string;
  name: string;
  center: [number, number];
  radiusM: number;
}

export default function SitesMapInner({ sites, zoom }: { sites: MapSite[]; zoom?: number }) {
  const single = sites.length === 1;
  const bounds: LatLngBoundsExpression = sites.map((s) => s.center);

  return (
    <MapContainer
      {...(single
        ? { center: sites[0].center, zoom: zoom ?? 17 }
        : { bounds, boundsOptions: { padding: [48, 48] } })}
      scrollWheelZoom={false}
      className="h-full w-full"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {sites.map((site) => (
        <Circle
          key={`${site.id}-fence`}
          center={site.center}
          radius={site.radiusM}
          pathOptions={{ color: "#1d4ed8", weight: 2, dashArray: "6 4", fillOpacity: 0.12 }}
        />
      ))}
      {sites.map((site) => (
        <CircleMarker
          key={site.id}
          center={site.center}
          radius={7}
          pathOptions={{ color: "#ffffff", weight: 2, fillColor: "#1d4ed8", fillOpacity: 1 }}
        >
          <Tooltip direction="top" offset={[0, -6]} permanent={!single}>
            {site.name}
          </Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
