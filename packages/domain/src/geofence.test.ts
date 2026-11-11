import { describe, expect, it } from "vitest";
import {
  GEOFENCE_LIMITS,
  geofenceMetrics,
  isInsideGeofence,
  isSelfIntersecting,
  normaliseGeofence,
  polygonAreaM2,
  validateGeofence,
  type Geofence,
} from "./geofence.js";
import type { LatLng } from "./geo.js";

const ruiru = { lat: -1.1489, lng: 36.9612 };
/** Metres → degrees near Ruiru (latitude −1.15°). */
const dLat = (m: number) => m / 111_195;
const dLng = (m: number) => m / (111_195 * Math.cos((ruiru.lat * Math.PI) / 180));
const offset = (east: number, north: number): LatLng => ({
  lat: ruiru.lat + dLat(north),
  lng: ruiru.lng + dLng(east),
});
const square = (side: number): LatLng[] => [
  offset(0, 0),
  offset(side, 0),
  offset(side, side),
  offset(0, side),
];
const polygon = (vertices: LatLng[]): Geofence => ({ kind: "polygon", vertices });

describe("radius geofences", () => {
  it("accepts a 120 m site radius in Ruiru", () => {
    expect(validateGeofence({ kind: "radius", center: ruiru, radiusM: 120 })).toEqual([]);
  });

  it("bounds the radius to whole metres between 20 and 5,000", () => {
    for (const radiusM of [GEOFENCE_LIMITS.minRadiusM, GEOFENCE_LIMITS.maxRadiusM])
      expect(validateGeofence({ kind: "radius", center: ruiru, radiusM })).toEqual([]);
    for (const radiusM of [19, 5_001, 120.5, 0, -50])
      expect(validateGeofence({ kind: "radius", center: ruiru, radiusM }), String(radiusM)).toEqual(
        ["radius_out_of_range"],
      );
  });

  it("rejects centres outside Kenya and non-numeric coordinates", () => {
    const london = { lat: 51.5072, lng: -0.1276 };
    expect(validateGeofence({ kind: "radius", center: london, radiusM: 100 })).toEqual([
      "coordinate_out_of_bounds",
    ]);
    expect(
      validateGeofence({ kind: "radius", center: { lat: Number.NaN, lng: 36.9 }, radiusM: 100 }),
    ).toEqual(["coordinate_invalid"]);
    // Kampala, Uganda: just west of the bounding box.
    expect(
      validateGeofence({ kind: "radius", center: { lat: 0.3476, lng: 32.5825 }, radiusM: 100 }),
    ).toEqual(["coordinate_out_of_bounds"]);
  });

  it("reports area and circumference", () => {
    const metrics = geofenceMetrics({ kind: "radius", center: ruiru, radiusM: 100 });
    expect(metrics.areaM2).toBeCloseTo(31_415.93, 1);
    expect(metrics.perimeterM).toBeCloseTo(628.32, 1);
  });
});

describe("polygon geofences", () => {
  it("accepts a 100 m square and measures its area and perimeter", () => {
    const fence = polygon(square(100));
    expect(validateGeofence(fence)).toEqual([]);
    const metrics = geofenceMetrics(fence);
    expect(metrics.areaM2).toBeGreaterThan(9_950);
    expect(metrics.areaM2).toBeLessThan(10_050);
    expect(metrics.perimeterM).toBeGreaterThan(398);
    expect(metrics.perimeterM).toBeLessThan(402);
  });

  it("measures the same area whichever way the vertices run", () => {
    expect(polygonAreaM2(square(80).reverse())).toBeCloseTo(polygonAreaM2(square(80)), 6);
  });

  it("rejects a self-intersecting bow tie", () => {
    const bowTie = [offset(0, 0), offset(100, 100), offset(100, 0), offset(0, 100)];
    expect(isSelfIntersecting(bowTie)).toBe(true);
    expect(validateGeofence(polygon(bowTie))).toEqual(["self_intersecting"]);
  });

  it("rejects an edge that doubles back over its neighbour", () => {
    const spike = [offset(0, 0), offset(100, 0), offset(100, 100), offset(100, 50)];
    expect(validateGeofence(polygon(spike))).toEqual(["self_intersecting"]);
  });

  it("accepts a concave (L-shaped) site that does not cross itself", () => {
    const lShape = [
      offset(0, 0),
      offset(100, 0),
      offset(100, 40),
      offset(40, 40),
      offset(40, 100),
      offset(0, 100),
    ];
    expect(isSelfIntersecting(lShape)).toBe(false);
    expect(validateGeofence(polygon(lShape))).toEqual([]);
  });

  it("rejects a repeated closing vertex: rings are open", () => {
    const closed = [...square(100), offset(0, 0)];
    expect(validateGeofence(polygon(closed))).toEqual(["closing_vertex_repeated"]);
  });

  it("rejects duplicate vertices", () => {
    const vertices = [offset(0, 0), offset(100, 0), offset(100, 0), offset(100, 100)];
    expect(validateGeofence(polygon(vertices))).toEqual(["duplicate_vertex"]);
  });

  it("needs 3 to 100 vertices", () => {
    expect(validateGeofence(polygon([offset(0, 0), offset(100, 0)]))).toEqual(["too_few_vertices"]);
    const circle = Array.from({ length: 101 }, (_, index) => {
      const angle = (2 * Math.PI * index) / 101;
      return offset(500 * Math.cos(angle), 500 * Math.sin(angle));
    });
    expect(validateGeofence(polygon(circle))).toEqual(["too_many_vertices"]);
    expect(validateGeofence(polygon(circle.slice(0, 100)))).toEqual([]);
  });

  it("rejects tiny and huge areas", () => {
    expect(validateGeofence(polygon(square(5)))).toEqual(["area_too_small"]);
    expect(validateGeofence(polygon(square(10_000)))).toEqual(["area_too_large"]);
    expect(validateGeofence(polygon(square(4_900)))).toEqual([]);
  });

  it("rejects vertices outside Kenya", () => {
    const vertices = square(100);
    vertices[2] = { lat: -1.14, lng: 30.1 };
    expect(validateGeofence(polygon(vertices))).toContain("coordinate_out_of_bounds");
    expect(
      validateGeofence(polygon([{ lat: Number.POSITIVE_INFINITY, lng: 36 }, ...square(100)])),
    ).toEqual(["coordinate_invalid"]);
  });
});

describe("normaliseGeofence", () => {
  it("rounds coordinates to six decimal places", () => {
    expect(
      normaliseGeofence({
        kind: "radius",
        center: { lat: -1.14890049, lng: 36.96120051 },
        radiusM: 80,
      }),
    ).toEqual({ kind: "radius", center: { lat: -1.1489, lng: 36.961201 }, radiusM: 80 });
  });
});

describe("isInsideGeofence", () => {
  it("checks polygons with an optional GPS tolerance", () => {
    const fence = polygon(square(100));
    expect(isInsideGeofence(offset(50, 50), fence)).toBe(true);
    expect(isInsideGeofence(offset(130, 50), fence)).toBe(false);
    expect(isInsideGeofence(offset(130, 50), fence, 40)).toBe(true);
  });

  it("checks radius geofences", () => {
    const fence: Geofence = { kind: "radius", center: ruiru, radiusM: 120 };
    expect(isInsideGeofence(offset(0, 100), fence)).toBe(true);
    expect(isInsideGeofence(offset(0, 150), fence)).toBe(false);
    expect(isInsideGeofence(offset(0, 150), fence, 50)).toBe(true);
  });
});
