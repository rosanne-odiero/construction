"use client";

import { usePathname } from "next/navigation";
import type { Portal } from "@pm-buddy/types";

/**
 * The portal's name under the logo. Signed in, it follows the role; signed out (join and PIN
 * pages) it follows the address, so a supplier's invitation never says "Labourer portal".
 */
export function PortalName({
  portal,
  names,
}: {
  portal: Portal | null;
  names: Record<Portal, string>;
}) {
  const pathname = usePathname();
  return names[portal ?? (pathname.startsWith("/supplier") ? "supplier" : "worker")];
}
