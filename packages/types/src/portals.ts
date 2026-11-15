import { isPermission, type Permission } from "./permissions.js";

/**
 * The web portals. People are sent to one by the permissions of the company they work in:
 * company staff use the office app, clients the client portal, labourers the worker portal and
 * supplier contacts the supplier portal (D7.2).
 */
export const PORTALS = ["office", "client", "worker", "supplier"] as const;
export type Portal = (typeof PORTALS)[number];

export const PORTAL_HOME: Readonly<Record<Portal, string>> = {
  office: "/projects",
  client: "/portal",
  worker: "/worker",
  supplier: "/supplier",
};

/** Permissions that do not, by themselves, make someone company staff. */
const NON_STAFF = new Set<Permission>([
  "projects.view",
  "bq.view",
  "portal.client",
  "portal.supplier",
  "portal.worker",
]);

/**
 * The portal for a role's permissions: any staff permission means the office app (so owners,
 * who hold every permission, stay in the office); otherwise the labourer, client or supplier
 * portal. Anything else (for example a view-only custom role) uses the office app.
 */
export function portalFor(permissions: Iterable<string>): Portal {
  const held = [...permissions].filter(isPermission);
  if (held.some((permission) => !NON_STAFF.has(permission))) return "office";
  if (held.includes("portal.worker")) return "worker";
  if (held.includes("portal.client")) return "client";
  if (held.includes("portal.supplier")) return "supplier";
  return "office";
}

/**
 * Whether a six-digit PIN session may act with these permissions: the labourer portal and nothing
 * else. Stricter than `portalFor`, which also counts view-only permissions as non-staff, so a
 * custom role holding `portal.worker` with `bq.view` is a worker there; a guessed PIN must still
 * not open BQ rates or contract sums.
 */
export function pinAllowed(permissions: Iterable<string>): boolean {
  const held = [...permissions];
  return held.length > 0 && held.every((permission) => permission === "portal.worker");
}
