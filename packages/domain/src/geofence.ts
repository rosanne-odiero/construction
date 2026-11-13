import { haversineMeters, isInPolygon, isWithinRadius, type LatLng } from "./geo.js";

/**
 * Site geofences (brief §5.1, D2.1): a radius around a centre, or a polygon. Shared by the web
 * editor, the API and (later) the site app, so all three agree on what a valid geofence is.
 * The database repeats the structural limits (bounding box, vertex count, radius and area ranges)
 * as CHECK constraints; the geometric rules (self-intersection, duplicates) are enforced here.
 */

/** A generous bounding box around Kenya, including the Ilemi Triangle and Lake Victoria. */
export const KENYA_BOUNDS = { minLat: -5, maxLat: 5.5, minLng: 33.5, maxLng: 42 } as const;

export const GEOFENCE_LIMITS = {
  /** Radius in whole metres: from a small plot to a large estate. */
  minRadiusM: 20,
  maxRadiusM: 5_000,
  minVertices: 3,
  maxVertices: 100,
  /** 100 m² (10 m × 10 m) up to 25 km². */
  minAreaM2: 100,
  maxAreaM2: 25_000_000,
  /** Coordinates are stored with six decimal places (about 11 cm). */
  coordinateDecimals: 6,
} as const;

export type RadiusGeofence = { kind: "radius"; center: LatLng; radiusM: number };
/** An open ring: vertices in drawing order; the closing edge back to the first is implied. */
export type PolygonGeofence = { kind: "polygon"; vertices: LatLng[] };
export type Geofence = RadiusGeofence | PolygonGeofence;

export const GEOFENCE_ISSUES = [
  "coordinate_invalid",
  "coordinate_out_of_bounds",
  "radius_out_of_range",
  "too_few_vertices",
  "too_many_vertices",
  "closing_vertex_repeated",
  "duplicate_vertex",
  "self_intersecting",
  "area_too_small",
  "area_too_large",
] as const;
export type GeofenceIssue = (typeof GEOFENCE_ISSUES)[number];

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const SCALE = 10 ** GEOFENCE_LIMITS.coordinateDecimals;

/** Rounds a coordinate to the stored precision (six decimal places). */
export const roundCoordinate = (value: number): number => Math.round(value * SCALE) / SCALE;

export const isFiniteCoordinate = (point: LatLng): boolean =>
  Number.isFinite(point.lat) && Number.isFinite(point.lng);

export const isWithinKenya = (point: LatLng): boolean =>
  isFiniteCoordinate(point) &&
  point.lat >= KENYA_BOUNDS.minLat &&
  point.lat <= KENYA_BOUNDS.maxLat &&
  point.lng >= KENYA_BOUNDS.minLng &&
  point.lng <= KENYA_BOUNDS.maxLng;

/** Rounds every coordinate to the stored precision; validate the result, not the input. */
export function normaliseGeofence(geofence: Geofence): Geofence {
  const round = (point: LatLng): LatLng => ({
    lat: roundCoordinate(point.lat),
    lng: roundCoordinate(point.lng),
  });
  return geofence.kind === "radius"
    ? { kind: "radius", center: round(geofence.center), radiusM: geofence.radiusM }
    : { kind: "polygon", vertices: geofence.vertices.map(round) };
}

type Point = { x: number; y: number };

/** Local equirectangular projection in metres; accurate to well under 0.1 % at site scale. */
function project(vertices: readonly LatLng[]): Point[] {
  const lat0 = vertices.reduce((sum, vertex) => sum + vertex.lat, 0) / vertices.length;
  const lng0 = vertices.reduce((sum, vertex) => sum + vertex.lng, 0) / vertices.length;
  const cos = Math.cos(toRad(lat0));
  return vertices.map((vertex) => ({
    x: toRad(vertex.lng - lng0) * EARTH_RADIUS_M * cos,
    y: toRad(vertex.lat - lat0) * EARTH_RADIUS_M,
  }));
}

/** Area of a simple polygon in square metres (shoelace formula on the local projection). */
export function polygonAreaM2(vertices: readonly LatLng[]): number {
  if (vertices.length < 3) return 0;
  const points = project(vertices);
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

/** Perimeter in metres, including the implied closing edge. */
export function polygonPerimeterM(vertices: readonly LatLng[]): number {
  if (vertices.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < vertices.length; i++)
    total += haversineMeters(vertices[i]!, vertices[(i + 1) % vertices.length]!);
  return total;
}

/** Vertex average; used to centre maps on a polygon. */
export function polygonCentre(vertices: readonly LatLng[]): LatLng {
  return {
    lat: vertices.reduce((sum, vertex) => sum + vertex.lat, 0) / vertices.length,
    lng: vertices.reduce((sum, vertex) => sum + vertex.lng, 0) / vertices.length,
  };
}

export type GeofenceMetrics = { areaM2: number; perimeterM: number; centre: LatLng };

export function geofenceMetrics(geofence: Geofence): GeofenceMetrics {
  if (geofence.kind === "radius")
    return {
      areaM2: Math.PI * geofence.radiusM ** 2,
      perimeterM: 2 * Math.PI * geofence.radiusM,
      centre: geofence.center,
    };
  return {
    areaM2: polygonAreaM2(geofence.vertices),
    perimeterM: polygonPerimeterM(geofence.vertices),
    centre: polygonCentre(geofence.vertices),
  };
}

const EPSILON = 1e-9;
const cross = (o: Point, a: Point, b: Point) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const orientation = (o: Point, a: Point, b: Point) => {
  const value = cross(o, a, b);
  return Math.abs(value) < EPSILON ? 0 : Math.sign(value);
};
const onSegment = (p: Point, a: Point, b: Point) =>
  Math.min(a.x, b.x) - EPSILON <= p.x &&
  p.x <= Math.max(a.x, b.x) + EPSILON &&
  Math.min(a.y, b.y) - EPSILON <= p.y &&
  p.y <= Math.max(a.y, b.y) + EPSILON;

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(c, a, b)) ||
    (o2 === 0 && onSegment(d, a, b)) ||
    (o3 === 0 && onSegment(a, c, d)) ||
    (o4 === 0 && onSegment(b, c, d))
  );
}

/**
 * True when any two edges cross or touch other than at their shared vertex, including an edge
 * that doubles back over its neighbour. Quadratic, which is fine for at most 100 vertices.
 */
export function isSelfIntersecting(vertices: readonly LatLng[]): boolean {
  const n = vertices.length;
  if (n < 3) return false;
  const points = project(vertices);
  const edge = (i: number): [Point, Point] => [points[i]!, points[(i + 1) % n]!];
  for (let i = 0; i < n; i++) {
    const [a, b] = edge(i);
    const [, next] = edge((i + 1) % n);
    // Adjacent edges share b; they overlap if they are collinear and the second turns back.
    if (
      orientation(a, b, next) === 0 &&
      (next.x - b.x) * (a.x - b.x) + (next.y - b.y) * (a.y - b.y) > 0
    )
      return true;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // the closing edge is adjacent to the first edge
      const [c, d] = edge(j);
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

const samePoint = (a: LatLng, b: LatLng) =>
  roundCoordinate(a.lat) === roundCoordinate(b.lat) &&
  roundCoordinate(a.lng) === roundCoordinate(b.lng);

/**
 * Every rule a geofence breaks, in a stable order; empty when it is valid. Validate the
 * normalised geofence (see normaliseGeofence) so the stored value is the one that was checked.
 */
export function validateGeofence(geofence: Geofence): GeofenceIssue[] {
  const issues = new Set<GeofenceIssue>();
  const points = geofence.kind === "radius" ? [geofence.center] : geofence.vertices;
  if (!points.every(isFiniteCoordinate)) return ["coordinate_invalid"];
  if (!points.every(isWithinKenya)) issues.add("coordinate_out_of_bounds");

  if (geofence.kind === "radius") {
    const { radiusM } = geofence;
    if (
      !Number.isInteger(radiusM) ||
      radiusM < GEOFENCE_LIMITS.minRadiusM ||
      radiusM > GEOFENCE_LIMITS.maxRadiusM
    )
      issues.add("radius_out_of_range");
    return GEOFENCE_ISSUES.filter((issue) => issues.has(issue));
  }

  const { vertices } = geofence;
  if (vertices.length > 1 && samePoint(vertices[0]!, vertices.at(-1)!))
    issues.add("closing_vertex_repeated");
  if (vertices.length < GEOFENCE_LIMITS.minVertices) issues.add("too_few_vertices");
  if (vertices.length > GEOFENCE_LIMITS.maxVertices) issues.add("too_many_vertices");
  const open = issues.has("closing_vertex_repeated") ? vertices.slice(0, -1) : vertices;
  for (let i = 0; i < open.length && !issues.has("duplicate_vertex"); i++)
    for (let j = i + 1; j < open.length; j++)
      if (samePoint(open[i]!, open[j]!)) {
        issues.add("duplicate_vertex");
        break;
      }
  if (
    open.length >= 3 &&
    open.length <= GEOFENCE_LIMITS.maxVertices &&
    !issues.has("duplicate_vertex") &&
    isSelfIntersecting(open)
  )
    issues.add("self_intersecting");
  if (open.length >= 3 && !issues.has("self_intersecting")) {
    const area = polygonAreaM2(open);
    if (area < GEOFENCE_LIMITS.minAreaM2) issues.add("area_too_small");
    if (area > GEOFENCE_LIMITS.maxAreaM2) issues.add("area_too_large");
  }
  return GEOFENCE_ISSUES.filter((issue) => issues.has(issue));
}

/** Shortest distance in metres from a point to a polygon's boundary. */
function distanceToBoundaryM(point: LatLng, vertices: readonly LatLng[]): number {
  const projected = project([...vertices, point]);
  const p = projected.at(-1)!;
  const ring = projected.slice(0, -1);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t =
      length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/**
 * Whether a point lies inside a geofence, allowing `toleranceM` for GPS accuracy (config:
 * attendance.geofence_tolerance_m). Attendance (D3.3) evaluates the version in force at capture.
 */
export function isInsideGeofence(point: LatLng, geofence: Geofence, toleranceM = 0): boolean {
  if (geofence.kind === "radius")
    return isWithinRadius(point, geofence.center, geofence.radiusM, toleranceM);
  if (isInPolygon(point, geofence.vertices)) return true;
  return toleranceM > 0 && distanceToBoundaryM(point, geofence.vertices) <= toleranceM;
}

/** How far outside a geofence a point lies, in metres (0 when inside or on the boundary). */
export function distanceOutsideGeofenceM(point: LatLng, geofence: Geofence): number {
  if (geofence.kind === "radius")
    return Math.max(0, haversineMeters(point, geofence.center) - geofence.radiusM);
  if (isInPolygon(point, geofence.vertices)) return 0;
  return distanceToBoundaryM(point, geofence.vertices);
}
