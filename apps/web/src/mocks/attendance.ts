import { seededRandom } from "./company";
import { labourerByName, labourers } from "./labour";

export type CaptureMethod = "face_kiosk" | "qr_card_photo" | "manual_override";
export type DayStatus = "present" | "late" | "absent";
export type AnomalyKind =
  | "impossible_travel"
  | "outside_geofence"
  | "clock_drift"
  | "manual_override"
  | "duplicate"
  | "low_confidence";
export type Severity = "critical" | "warning" | "info";

export interface MusterRecord {
  labourerId: string;
  status: DayStatus;
  checkIn?: string;
  checkOut?: string;
  method?: CaptureMethod;
  confidence?: number;
  insideGeofence?: boolean;
  distanceM?: number;
  device?: string;
  flags: AnomalyKind[];
  nightShift?: boolean;
}

export interface Anomaly {
  id: string;
  kind: AnomalyKind;
  severity: Severity;
  labourerId?: string;
  at: string;
  status: "open" | "auto_resolved";
  params: Record<string, string | number>;
}

// COMPLIANCE-REVIEW: start time, lateness grace and thresholds come from timesheet config.
export const ATTENDANCE_RULES = { lateAfter: "07:15", faceMatchThreshold: 0.8, driftMinutes: 5 };

const DAY = "2026-11-10";
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00+03:00`;
const id = (name: string) => labourerByName(name)?.id ?? "";

const absent = new Set(["Felix Okoth Owuor", "Peter Ndungu Waweru", "Sankale Lemayian"]);
const declined = new Set(
  labourers.filter((l) => l.biometricConsent === "declined").map((l) => l.name),
);
const gangCOnKiosk2 = new Set([
  "Daniel Cheruiyot Langat",
  "Michael Musyoka Mutiso",
  "Elijah Kipchumba Kibet",
]);

const special: Record<string, Partial<MusterRecord>> = {
  "Erick Owino Onyango": { status: "late", checkIn: at("07:20"), flags: ["impossible_travel"] },
  "Dennis Ochieng Owiti": {
    status: "late",
    checkIn: at("07:41"),
    method: "face_kiosk",
    confidence: 0.71,
    flags: ["low_confidence"],
  },
  "Beatrice Nafula Wekesa": { status: "late", checkIn: at("07:32") },
  "Wycliffe Wekesa Barasa": {
    checkIn: at("07:08"),
    method: "qr_card_photo",
    confidence: undefined,
    insideGeofence: false,
    distanceM: 412,
    device: "FOREMAN-RU-02",
    flags: ["outside_geofence"],
  },
  "Samuel Kariuki Mwangi": { checkIn: at("07:02"), flags: ["duplicate"] },
  "Moses Muli Kioko": {
    checkIn: at("07:10"),
    method: "manual_override",
    confidence: undefined,
    device: "FOREMAN-RU-01",
    flags: ["manual_override"],
  },
};

const rand = seededRandom(1110);

export const muster: MusterRecord[] = labourers.map((l) => {
  if (absent.has(l.name)) return { labourerId: l.id, status: "absent", flags: [] };
  if (l.trade === "watchman") {
    return {
      labourerId: l.id,
      status: "present",
      nightShift: true,
      checkIn: at("18:00", "2026-11-09"),
      checkOut: at("06:02"),
      method: declined.has(l.name) ? "qr_card_photo" : "face_kiosk",
      confidence: declined.has(l.name) ? undefined : 0.94,
      insideGeofence: true,
      device: "KIOSK-RU-01",
      flags: [],
    };
  }
  const minute = 40 + Math.floor(rand() * 34);
  const hh = minute >= 60 ? "07" : "06";
  const mm = String(minute % 60).padStart(2, "0");
  const base: MusterRecord = {
    labourerId: l.id,
    status: "present",
    checkIn: at(`${hh}:${mm}`),
    method: declined.has(l.name) ? "qr_card_photo" : "face_kiosk",
    confidence: declined.has(l.name) ? undefined : Number((0.88 + rand() * 0.11).toFixed(2)),
    insideGeofence: true,
    device: gangCOnKiosk2.has(l.name) ? "KIOSK-RU-02" : "KIOSK-RU-01",
    flags: gangCOnKiosk2.has(l.name) ? ["clock_drift"] : [],
  };
  return { ...base, ...special[l.name] };
});

export const anomalies: Anomaly[] = [
  {
    id: "an-1",
    kind: "impossible_travel",
    severity: "critical",
    labourerId: id("Erick Owino Onyango"),
    at: at("07:20"),
    status: "open",
    params: {
      siteA: "Kitengela Bungalow",
      timeA: "06:55",
      siteB: "Ruiru Heights",
      timeB: "07:20",
      km: 34,
      minutes: 25,
    },
  },
  {
    id: "an-2",
    kind: "outside_geofence",
    severity: "warning",
    labourerId: id("Wycliffe Wekesa Barasa"),
    at: at("07:08"),
    status: "open",
    params: { distance: 412, accuracy: 15, device: "FOREMAN-RU-02" },
  },
  {
    id: "an-3",
    kind: "clock_drift",
    severity: "warning",
    at: at("07:40"),
    status: "open",
    params: { device: "KIOSK-RU-02", minutes: 14, events: 3 },
  },
  {
    id: "an-4",
    kind: "manual_override",
    severity: "warning",
    labourerId: id("Moses Muli Kioko"),
    at: at("07:10"),
    status: "open",
    params: { by: "Joseph Mutua", reason: "Kiosk camera not detecting face (glare)" },
  },
  {
    id: "an-5",
    kind: "duplicate",
    severity: "info",
    labourerId: id("Samuel Kariuki Mwangi"),
    at: at("07:05"),
    status: "auto_resolved",
    params: { first: "07:02", second: "07:05" },
  },
  {
    id: "an-6",
    kind: "low_confidence",
    severity: "info",
    labourerId: id("Dennis Ochieng Owiti"),
    at: at("07:41"),
    status: "auto_resolved",
    params: { score: "0.71", threshold: "0.80" },
  },
];

export const musterSummary = {
  rostered: muster.length,
  present: muster.filter((m) => m.status !== "absent").length,
  late: muster.filter((m) => m.status === "late").length,
  absent: muster.filter((m) => m.status === "absent").length,
  anomalies: anomalies.length,
  critical: anomalies.filter((a) => a.severity === "critical").length,
};
