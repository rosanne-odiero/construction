import { isPermission, type Permission } from "./permissions.js";

/**
 * The three web portals. People are sent to one by the permissions of the company they work in:
 * company staff use the office app, clients the client portal, labourers the worker portal.
 */
export const PORTALS = ["office", "client", "worker"] as const;
export type Portal = (typeof PORTALS)[number];

export const PORTAL_HOME: Readonly<Record<Portal, string>> = {
  office: "/projects",
  client: "/portal",
  worker: "/worker",
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
 * who hold every permission, stay in the office); otherwise the labourer or client portal.
 * Anything else (for example a view-only custom role or a supplier) uses the office app.
 */
export function portalFor(permissions: Iterable<string>): Portal {
  const held = [...permissions].filter(isPermission);
  if (held.some((permission) => !NON_STAFF.has(permission))) return "office";
  if (held.includes("portal.worker")) return "worker";
  if (held.includes("portal.client")) return "client";
  return "office";
}
