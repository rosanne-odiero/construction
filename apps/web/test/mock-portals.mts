/**
 * Client and labourer personas for the mock API (cookie `pmb_at=client.<id>` or
 * `labourer.<id>`): the session, company list and portal responses the live portal pages read.
 * Everything else is refused with 403, as the real API refuses office data to these roles.
 * Synthetic data only; every response is checked against the shared schema by mock-api.mts.
 */
import type { z } from "zod";
import {
  authResponseSchema,
  clientProjectResponseSchema,
  clientProjectsResponseSchema,
  tenantsResponseSchema,
  workerPortalResponseSchema,
} from "@pm-buddy/validation";

export type PortalPersona = "client" | "labourer";
type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };

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
  method: string,
  path: string,
  fail: (status: number, code: string) => Error,
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
  if (persona === "client" && method === "GET" && path === "/portal/client/projects")
    return {
      body: {
        company: TENANT,
        projects: [
          {
            ...ruiru,
            startDate: "2026-03-02",
            endDate: "2027-04-30",
            contractSumMinor: 8_640_000_000,
            currency: "KES",
            milestones: { total: 3, achieved: 1 },
          },
        ],
      },
      schema: clientProjectsResponseSchema,
    };
  if (persona === "client" && method === "GET" && path === `/portal/client/projects/${RUIRU}`)
    return {
      body: {
        project: {
          ...ruiru,
          startDate: "2026-03-02",
          endDate: "2027-04-30",
          contractSumMinor: 8_640_000_000,
          currency: "KES",
          milestones: { total: 3, achieved: 1 },
        },
        milestones: [
          {
            id: "32000000-0000-4000-8000-000000000001",
            name: "Foundations complete",
            dueDate: "2026-05-15",
            status: "achieved",
            actualDate: "2026-05-12",
          },
          {
            id: "32000000-0000-4000-8000-000000000002",
            name: "First floor slab",
            dueDate: "2026-12-01",
            status: "in_progress",
            actualDate: null,
          },
          {
            id: "32000000-0000-4000-8000-000000000003",
            name: "Roof",
            dueDate: "2027-02-15",
            status: "planned",
            actualDate: null,
          },
        ],
        diaries: [
          {
            id: "33000000-0000-4000-8000-000000000001",
            date: "2026-11-09",
            siteName: "Main plot",
            workPerformed: "Synthetic: first-floor columns cast and cured.",
            weather: "Dry",
            delays: null,
            workforceCount: 18,
            approvedAt: "2026-11-09T15:00:00.000Z",
          },
        ],
      },
      schema: clientProjectResponseSchema,
    };
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
