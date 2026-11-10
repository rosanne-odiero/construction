export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Radius geofence check. `toleranceM` absorbs GPS accuracy (config: attendance.geofence_tolerance_m). */
export function isWithinRadius(
  point: LatLng,
  center: LatLng,
  radiusM: number,
  toleranceM = 0,
): boolean {
  return haversineMeters(point, center) <= radiusM + toleranceM;
}

/** Polygon geofence check (ray casting). Fine for site-sized polygons; vertices in order, not closed. */
export function isInPolygon(point: LatLng, polygon: readonly LatLng[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const crosses = a.lat > point.lat !== b.lat > point.lat;
    if (crosses && point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng)
      inside = !inside;
  }
  return inside;
}

/**
 * Speed implied by two check-ins, in km/h. Used by the impossible-travel anomaly rule
 * (config: attendance.impossible_travel_kmh).
 */
export function impliedSpeedKmh(from: LatLng, to: LatLng, minutesApart: number): number {
  if (minutesApart <= 0) return Number.POSITIVE_INFINITY;
  return haversineMeters(from, to) / 1000 / (minutesApart / 60);
}
