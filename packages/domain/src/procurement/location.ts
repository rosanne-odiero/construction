import { P2P_LIMITS, type GrnLocationState } from "@pm-buddy/types";
import type { LatLng } from "../geo.js";
import { isFiniteCoordinate, isInsideGeofence, type Geofence } from "../geofence.js";

export interface PositionFix extends LatLng {
  /** The reported accuracy radius in metres (browser Geolocation API or the device). */
  accuracyM: number;
}

export interface DeliveryLocation {
  state: GrnLocationState;
  /** The fix is less precise than `P2P_LIMITS.gpsMaxAccuracyM`. */
  lowAccuracy: boolean;
}

/**
 * Where a delivery was recorded against the site geofence in force (D5.2, brief §15 E). The
 * check allows the reported accuracy, capped at `P2P_LIMITS.gpsToleranceCapM`. The result is a
 * review signal, never a refusal: a phone's position can be wrong or spoofed, and a GRN outside
 * the geofence is flagged, not blocked. Photos' EXIF positions are never used.
 */
export function assessDeliveryLocation(
  fix: PositionFix | null,
  geofence: Geofence | null,
): DeliveryLocation {
  if (!fix || !isFiniteCoordinate(fix) || !Number.isFinite(fix.accuracyM) || fix.accuracyM < 0)
    return { state: "no_fix", lowAccuracy: false };
  const lowAccuracy = fix.accuracyM > P2P_LIMITS.gpsMaxAccuracyM;
  if (!geofence) return { state: "no_geofence", lowAccuracy };
  const tolerance = Math.min(fix.accuracyM, P2P_LIMITS.gpsToleranceCapM);
  return {
    state: isInsideGeofence({ lat: fix.lat, lng: fix.lng }, geofence, tolerance)
      ? "inside"
      : "outside",
    lowAccuracy,
  };
}
