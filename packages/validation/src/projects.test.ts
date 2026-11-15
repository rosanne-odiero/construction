import { describe, expect, it } from "vitest";
import {
  changeGeofenceRequestSchema,
  createMilestoneRequestSchema,
  createProjectRequestSchema,
  createSiteRequestSchema,
  createWbsNodeRequestSchema,
  milestoneStatusRequestSchema,
  projectAssignmentRequestSchema,
  projectDetailResponseSchema,
  projectStatusRequestSchema,
  reorderWbsRequestSchema,
  siteResponseSchema,
  updateMilestoneRequestSchema,
  updateProjectRequestSchema,
  updateWbsNodeRequestSchema,
  wbsResponseSchema,
} from "./index.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const date = "2026-11-10T20:00:00.000Z";
const ruiru = { lat: -1.1489, lng: 36.9612 };
const square = [
  { lat: -1.1489, lng: 36.9612 },
  { lat: -1.1489, lng: 36.9621 },
  { lat: -1.148, lng: 36.9621 },
  { lat: -1.148, lng: 36.9612 },
];
const messages = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((issue) => issue.message) ?? [];

describe("project requests", () => {
  it("needs only a name to start planning and normalises code, contact and blanks", () => {
    expect(createProjectRequestSchema.parse({ name: " Ruiru Heights " })).toEqual({
      name: "Ruiru Heights",
    });
    expect(
      createProjectRequestSchema.parse({
        code: " rui-hts ",
        name: "Ruiru Heights",
        clientName: "Mavuno Homes Ltd",
        clientEmail: "Procurement@Mavuno.Example.Test",
        clientPhone: "0712 345 678",
        description: "",
        contractSumMinor: 8_640_000_000,
        contractType: "lump_sum",
        startDate: "2026-03-02",
        endDate: "2027-04-30",
        county: "kiambu",
        town: "Ruiru",
        latitude: -1.1489,
        longitude: 36.9612,
      }),
    ).toMatchObject({
      code: "RUI-HTS",
      clientEmail: "procurement@mavuno.example.test",
      clientPhone: "254712345678",
      description: null,
    });
    expect(
      createProjectRequestSchema.parse({ name: "X", clientPhone: "+44 20 7946 0000" }),
    ).toMatchObject({ clientPhone: "+442079460000" });
  });

  it("refuses unknown fields, bad codes, floats, foreign coordinates and end before start", () => {
    for (const body of [
      { name: "X", tenantId: id },
      { name: "X", code: "A" },
      { name: "X", code: "ÜBER" },
      { name: "X", contractSumMinor: 10.5 },
      { name: "X", contractSumMinor: -1 },
      { name: "X", county: "london" },
      { name: "X", contractType: "handshake" },
      { name: "X", latitude: 51.5, longitude: -0.12 },
      { name: "X", latitude: -1.1 },
      { name: "X", startDate: "2026-05-01", endDate: "2026-04-30" },
      { name: "X", startDate: "01/05/2026" },
      { name: "X", clientPhone: "12345" },
      { name: "" },
    ])
      expect(createProjectRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    expect(
      messages(
        createProjectRequestSchema.safeParse({
          name: "X",
          startDate: "2026-05-01",
          endDate: "2026-04-30",
        }),
      ),
    ).toContain("end_before_start");
  });

  it("needs a version and at least one change to update", () => {
    expect(updateProjectRequestSchema.safeParse({ name: "New" }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateProjectRequestSchema.parse({ version: 3, town: "" })).toEqual({
      version: 3,
      town: null,
    });
    expect(updateProjectRequestSchema.parse({ version: 3, clientEmail: null })).toEqual({
      version: 3,
      clientEmail: null,
    });
  });

  it("validates status change requests", () => {
    expect(projectStatusRequestSchema.safeParse({ to: "active", version: 1 }).success).toBe(true);
    expect(projectStatusRequestSchema.safeParse({ to: "archived", version: 1 }).success).toBe(
      false,
    );
    expect(
      projectStatusRequestSchema.safeParse({ to: "on_hold", reason: "x".repeat(501), version: 1 })
        .success,
    ).toBe(false);
  });
});

describe("geofence requests", () => {
  it("accepts a valid radius and polygon, rounding coordinates", () => {
    const radius = createSiteRequestSchema.parse({
      name: "Main site",
      geofence: { kind: "radius", center: { lat: -1.14890049, lng: 36.9612 }, radiusM: 120 },
    });
    expect(radius.geofence).toEqual({ kind: "radius", center: ruiru, radiusM: 120 });
    expect(
      changeGeofenceRequestSchema.parse({
        geofence: { kind: "polygon", vertices: square },
        currentVersion: 1,
      }).geofence,
    ).toEqual({ kind: "polygon", vertices: square });
  });

  it("reports the shared domain issue codes", () => {
    const check = (geofence: unknown) =>
      messages(changeGeofenceRequestSchema.safeParse({ geofence, currentVersion: 1 }));
    expect(check({ kind: "radius", center: ruiru, radiusM: 10 })).toEqual(["radius_out_of_range"]);
    expect(check({ kind: "radius", center: { lat: 51.5, lng: -0.12 }, radiusM: 100 })).toEqual([
      "coordinate_out_of_bounds",
    ]);
    expect(check({ kind: "polygon", vertices: [...square, square[0]] })).toEqual([
      "closing_vertex_repeated",
    ]);
    expect(
      check({ kind: "polygon", vertices: [square[0], square[2], square[1], square[3]] }),
    ).toEqual(["self_intersecting"]);
    expect(check({ kind: "circle", center: ruiru })).not.toEqual([]);
  });

  it("validates site responses with the current geofence version", () => {
    const site = {
      id,
      name: "Main site",
      address: null,
      version: 1,
      createdAt: date,
      updatedAt: date,
      geofence: {
        id,
        version: 2,
        effectiveFrom: date,
        areaM2: 10_000,
        perimeterM: 400,
        geofence: { kind: "polygon", vertices: square },
      },
    };
    expect(siteResponseSchema.parse({ site })).toEqual({ site });
    expect(siteResponseSchema.safeParse({ site: { ...site, tenantId: id } }).success).toBe(false);
  });
});

describe("WBS, milestone and team requests", () => {
  it("validates WBS nodes, weights and reorder lists", () => {
    expect(createWbsNodeRequestSchema.parse({ code: "1.2", name: "Substructure" })).toEqual({
      code: "1.2",
      name: "Substructure",
      weightBasisPoints: 0,
    });
    for (const weightBasisPoints of [-1, 10_001, 12.5])
      expect(
        createWbsNodeRequestSchema.safeParse({ code: "1", name: "X", weightBasisPoints }).success,
      ).toBe(false);
    expect(updateWbsNodeRequestSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateWbsNodeRequestSchema.safeParse({ version: 1, parentId: null }).success).toBe(true);
    expect(reorderWbsRequestSchema.safeParse({ parentId: null, nodeIds: [id, id] }).success).toBe(
      false,
    );
    expect(
      wbsResponseSchema.parse({
        nodes: [],
        weights: { complete: false, groups: [] },
        progress: null,
      }).progress,
    ).toBeNull();
  });

  it("keeps planning dates within 2000–2099, so one typo cannot break a schedule", () => {
    const due = (dueDate: string) =>
      createMilestoneRequestSchema.safeParse({ name: "Roof", dueDate }).success;
    expect([due("2000-01-01"), due("2099-12-31")]).toEqual([true, true]);
    expect([due("1999-12-31"), due("2100-01-01"), due("20260-01-01")]).toEqual([
      false,
      false,
      false,
    ]);
    expect(
      updateMilestoneRequestSchema.safeParse({ dueDate: "2100-01-01", version: 1 }).success,
    ).toBe(false);
    expect(
      createProjectRequestSchema.safeParse({ name: "Ruiru", startDate: "1990-01-01" }).success,
    ).toBe(false);
  });

  it("validates milestone status requests", () => {
    expect(
      milestoneStatusRequestSchema.safeParse({
        to: "achieved",
        actualDate: "2026-11-10",
        version: 2,
      }).success,
    ).toBe(true);
    expect(milestoneStatusRequestSchema.safeParse({ to: "done", version: 2 }).success).toBe(false);
  });

  it("accepts only project-assignable permissions, once each", () => {
    expect(
      projectAssignmentRequestSchema.safeParse({
        permissions: ["projects.view", "bq.edit", "attendance.record", "stores.manage"],
      }).success,
    ).toBe(true);
    expect(
      projectAssignmentRequestSchema.safeParse({ permissions: ["portal.client", "portal.worker"] })
        .success,
    ).toBe(true);
    for (const permissions of [
      ["payments.approve"],
      ["projects.create"],
      ["portal.supplier"],
      ["projects.view", "projects.view"],
    ])
      expect(projectAssignmentRequestSchema.safeParse({ permissions }).success).toBe(false);
  });

  it("validates the project detail response", () => {
    const project = {
      id,
      code: "RUI-HTS",
      name: "Ruiru Heights",
      description: null,
      clientName: "Mavuno Homes Ltd",
      clientEmail: null,
      clientPhone: null,
      contractSumMinor: 8_640_000_000,
      currency: "KES",
      contractType: "lump_sum",
      startDate: "2026-03-02",
      endDate: "2027-04-30",
      county: "kiambu",
      town: "Ruiru",
      latitude: null,
      longitude: null,
      status: "active",
      version: 4,
      createdAt: date,
      updatedAt: date,
    };
    const detail = {
      project,
      permissions: ["projects.view", "projects.manage"],
      siteCount: 1,
      activationGaps: [],
      history: [
        {
          from: "planning",
          to: "active",
          reason: null,
          changedAt: date,
          changedBy: { id, displayName: "Wanjiru Kamau" },
        },
      ],
    };
    expect(projectDetailResponseSchema.parse(detail)).toEqual(detail);
    expect(
      projectDetailResponseSchema.safeParse({ ...detail, project: { ...project, currency: "USD" } })
        .success,
    ).toBe(false);
  });
});
