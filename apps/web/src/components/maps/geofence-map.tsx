"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { MapFence } from "./geofence-map-inner";

const GeofenceMapInner = dynamic(() => import("./geofence-map-inner"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

/** Leaflet runs in the browser only; the region label names the map for assistive technology. */
export function GeofenceMap({
  fences,
  label,
  className,
}: {
  fences: MapFence[];
  label: string;
  className?: string;
}) {
  const t = useTranslations("sites.editor");
  return (
    <div
      role="region"
      aria-label={label}
      className={cn("h-72 w-full overflow-hidden rounded-lg border", className)}
    >
      <GeofenceMapInner fences={fences} labels={{ zoomIn: t("zoomIn"), zoomOut: t("zoomOut") }} />
    </div>
  );
}
