"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { MapSite } from "./sites-map-inner";

const SitesMapInner = dynamic(() => import("./sites-map-inner"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

export function SitesMap({
  sites,
  zoom,
  className,
  label,
}: {
  sites: MapSite[];
  zoom?: number;
  className?: string;
  label: string;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      className={cn("h-64 w-full overflow-hidden rounded-lg border", className)}
    >
      <SitesMapInner sites={sites} zoom={zoom} />
    </div>
  );
}
