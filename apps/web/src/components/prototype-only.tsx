"use client";

import { usePathname } from "next/navigation";
import { isLiveRoute } from "@/components/nav-config";

/** Renders its children (the prototype banner) everywhere except on live, API-backed routes. */
export function PrototypeOnly({ children }: { children: React.ReactNode }) {
  return isLiveRoute(usePathname()) ? null : children;
}
