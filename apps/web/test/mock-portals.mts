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
  workerNotificationPreferencesSchema,
  workerNotificationRequestSchema,
  workerNotificationHistorySchema,
  messageResponseSchema,
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
const preferences = new Map<string, { sms: boolean; whatsapp: boolean; locale: "en" | "sw" }>();
const histories = new Map<string, z.infer<typeof workerNotificationHistorySchema>["items"]>();
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
  if (persona === "labourer" && path === "/portal/worker/notifications") {
    if (method === "PUT")
      preferences.set(session, parse(workerNotificationPreferencesSchema, body));
    if (method === "GET" || method === "PUT")
      return {
        body: preferences.get(session) ?? { sms: false, whatsapp: false, locale: "en" },
        schema: workerNotificationPreferencesSchema,
      };
  }
  if (persona === "labourer" && method === "POST" && path === "/portal/worker/notifications/send") {
    const { channel } = parse(workerNotificationRequestSchema, body);
    if (!preferences.get(session)?.[channel]) throw fail(403, "forbidden");
    histories.set(
      session,
      [
        {
          id: crypto.randomUUID(),
          topic: "worker.reminder" as const,
          channel,
          status: "accepted" as const,
          reason: null,
          createdAt: new Date().toISOString(),
        },
        ...(histories.get(session) ?? []),
      ].slice(0, 50),
    );
    return { body: { message: "Accepted by test provider" }, schema: messageResponseSchema };
  }
  if (persona === "labourer" && method === "GET" && path === "/portal/worker/notifications/history")
    return {
      body: { items: histories.get(session) ?? [] },
      schema: workerNotificationHistorySchema,
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
        attendance: {
          from: "2026-11-01",
          to: "2026-11-15",
          daysWorked: 1.5,
          records: [
            {
              id: "32000000-0000-4000-8000-000000000001",
              date: "2026-11-14",
              project: ruiru.name,
              site: "Main plot",
              status: "present",
              confirmed: true,
            },
            {
              id: "32000000-0000-4000-8000-000000000002",
              date: "2026-11-13",
              project: ruiru.name,
              site: "Main plot",
              status: "half_day",
              confirmed: true,
            },
          ],
        },
        pay: {
          lines: [
            {
              id: "33000000-0000-4000-8000-000000000001",
              project: ruiru.name,
              from: "2026-11-01",
              to: "2026-11-07",
              grossMinor: "420000",
              deductionsMinor: "20000",
              netMinor: "400000",
              daysWorked: 6,
            },
          ],
          advancesOutstandingMinor: "150000",
          payments: null,
        },
      },
      schema: workerPortalResponseSchema,
    };
  throw fail(403, "forbidden");
}
