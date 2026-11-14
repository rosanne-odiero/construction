/**
 * Client and labourer personas for the mock API (cookie `pmb_at=client.<id>` or
 * `labourer.<id>`): the session, company list and portal responses the live portal pages read
 * (the client portal itself is mock-client-portal.mts).
 * Everything else is refused with 403, as the real API refuses office data to these roles.
 * Synthetic data only; every response is checked against the shared schema by mock-api.mts.
 */
import type { z } from "zod";
import {
  authResponseSchema,
  tenantsResponseSchema,
  workerPortalResponseSchema,
} from "@pm-buddy/validation";
import { handleClientPortal } from "./mock-client-portal.mts";

export type PortalPersona = "client" | "labourer";
type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
type Parse = <T>(schema: z.ZodType<T>, body: unknown) => T;

const TENANT = { id: "20000000-0000-4000-8000-000000000001", name: "Jenga Bora Builders Ltd" };
const RUIRU = "30000000-0000-4000-8000-000000000001";
const MAIN_PLOT = "31000000-0000-4000-8000-000000000001";
const people = {
  client: {
    id: "21000000-0000-4000-8000-000000000011",
    identifier: "grace.wambui@example.test",
    displayName: "Grace Wambui",
    role: "client",
    permissions: ["projects.view", "bq.view", "portal.client"],
  },
  labourer: {
    id: "21000000-0000-4000-8000-000000000012",
    identifier: "254712345678",
    displayName: "Otieno Ouma",
    role: "labourer",
    permissions: ["portal.worker"],
  },
} as const;
const ruiru = {
  id: RUIRU,
  code: "RUI-HTS",
  name: "Ruiru Heights Apartments",
  status: "active",
  county: "kiambu",
  town: "Ruiru",
} as const;

export const isPortalPersona = (value: string | undefined): value is PortalPersona =>
  value === "client" || value === "labourer";

export function handlePortalPersona(
  persona: PortalPersona,
  session: string,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  fail: (status: number, code: string) => Error,
  parse: Parse,
): Reply {
  const person = people[persona];
  if (method === "GET" && path === "/auth/me")
    return {
      body: {
        user: {
          id: person.id,
          identifier: person.identifier,
          displayName: person.displayName,
          verified: true,
          mfaEnabled: false,
          totpEnabled: false,
          passkeys: 0,
        },
        session: {
          id: "22000000-0000-4000-8000-000000000009",
          tenantId: TENANT.id,
          mfaVerified: false,
          expiresAt: "2026-11-11T07:45:00.000Z",
        },
        mfaRequired: false,
      },
      schema: authResponseSchema,
    };
  if (method === "GET" && path === "/tenants")
    return {
      body: {
        tenants: [
          {
            ...TENANT,
            role: person.role,
            roleName: null,
            tenantWide: false,
            permissions: [...person.permissions],
          },
        ],
      },
      schema: tenantsResponseSchema,
    };
  if (persona === "client" && path.startsWith("/portal/client/"))
    return handleClientPortal(session, method, path, query, body, fail, parse);
  if (persona === "labourer" && method === "GET" && path === "/portal/worker")
    return {
      body: {
        displayName: person.displayName,
        company: TENANT,
        assignments: [
          {
            project: ruiru,
            sites: [{ id: MAIN_PLOT, name: "Main plot", address: "Off Thika Road, Ruiru" }],
          },
        ],
        attendance: null,
        pay: null,
      },
      schema: workerPortalResponseSchema,
    };
  throw fail(403, "forbidden");
}
