import {
  billDoneMinor,
  billTotalMinor,
  revisedContractSumMinor,
  ruiruBills,
  ruiruSummary,
} from "./bq";
import { musterSummary } from "./attendance";
import { people } from "./company";

export type ProjectId = "ruiru-heights" | "kitengela-bungalow";
export type ProjectHealth = "on_track" | "at_risk" | "behind";

export type MilestoneKey =
  | "substructure"
  | "firstSlabs"
  | "secondSlab"
  | "roofBeam"
  | "roofCovered"
  | "practicalCompletion"
  | "foundation"
  | "ringBeam"
  | "plastering"
  | "finishes"
  | "handover";

export interface Milestone {
  key: MilestoneKey;
  planned: string;
  actual?: string;
  state: "done" | "at_risk" | "upcoming" | "in_progress";
}

export interface Project {
  id: ProjectId;
  code: string;
  name: string;
  description: string;
  town: string;
  county: string;
  client: string;
  contractType: string;
  originalSumMinor: number;
  revisedSumMinor: number;
  startDate: string;
  endDate: string;
  siteAgent: string;
  center: [number, number];
  radiusM: number;
  progress: number;
  plannedProgress: number;
  cpi: number;
  spi: number;
  budgetBurn: number;
  workersToday: number;
  workersRostered: number;
  openIssues: number;
  health: ProjectHealth;
  milestones: Milestone[];
}

const ruiruProgress = ruiruSummary.progress;
const PLANNED_TO_DATE = 0.52;

export const projects: Project[] = [
  {
    id: "ruiru-heights",
    code: "RUI-HTS",
    name: "Ruiru Heights Apartments",
    description: "4-storey apartment block, 16 units",
    town: "Ruiru",
    county: "Kiambu",
    client: "Mavuno Homes Ltd",
    contractType: "Lump sum (JBC)",
    originalSumMinor: ruiruSummary.contractSumMinor,
    revisedSumMinor: revisedContractSumMinor,
    startDate: "2026-03-02",
    endDate: "2027-04-30",
    siteAgent: people.siteAgent,
    center: [-1.1489, 36.9612],
    radiusM: 120,
    progress: ruiruProgress,
    plannedProgress: PLANNED_TO_DATE,
    cpi: 0.95,
    spi: Number((ruiruProgress / PLANNED_TO_DATE).toFixed(2)),
    budgetBurn: 0.51,
    workersToday: musterSummary.present,
    workersRostered: musterSummary.rostered,
    openIssues: 4,
    health: "at_risk",
    milestones: [
      { key: "substructure", planned: "2026-06-15", actual: "2026-06-26", state: "done" },
      { key: "firstSlabs", planned: "2026-08-31", actual: "2026-09-18", state: "done" },
      { key: "secondSlab", planned: "2026-10-15", actual: "2026-11-06", state: "done" },
      { key: "roofBeam", planned: "2026-11-30", state: "at_risk" },
      { key: "roofCovered", planned: "2027-01-31", state: "upcoming" },
      { key: "practicalCompletion", planned: "2027-04-30", state: "upcoming" },
    ],
  },
  {
    id: "kitengela-bungalow",
    code: "KIT-BNG",
    name: "Kitengela Bungalow",
    description: "3-bedroom bungalow for a diaspora client",
    town: "Kitengela",
    county: "Kajiado",
    client: "Dr. Grace Wambui (London, UK)",
    contractType: "Lump sum (JBC)",
    originalSumMinor: 9_846_400_00,
    revisedSumMinor: 10_062_160_00,
    startDate: "2026-05-12",
    endDate: "2027-02-15",
    siteAgent: "Ann Chebet",
    center: [-1.4772, 36.9589],
    radiusM: 60,
    progress: 0.58,
    plannedProgress: 0.59,
    cpi: 1.02,
    spi: 0.98,
    budgetBurn: 0.56,
    workersToday: 11,
    workersRostered: 12,
    openIssues: 1,
    health: "on_track",
    milestones: [
      { key: "foundation", planned: "2026-06-10", actual: "2026-06-14", state: "done" },
      { key: "ringBeam", planned: "2026-08-20", actual: "2026-08-22", state: "done" },
      { key: "roofCovered", planned: "2026-10-05", actual: "2026-10-03", state: "done" },
      { key: "plastering", planned: "2026-11-20", state: "in_progress" },
      { key: "finishes", planned: "2026-12-18", state: "upcoming" },
      { key: "handover", planned: "2027-02-15", state: "upcoming" },
    ],
  },
];

export const getProject = (id: string) => projects.find((p) => p.id === id);

const PLANNED_CURVE = [2, 6, 11, 17, 24, 31, 38, 45, 52, 60, 70, 81, 92, 100];
const ACTUAL_SHAPE = [0.04, 0.12, 0.23, 0.36, 0.51, 0.66, 0.8, 0.92, 1];
const MONTHS = [
  "2026-03",
  "2026-04",
  "2026-05",
  "2026-06",
  "2026-07",
  "2026-08",
  "2026-09",
  "2026-10",
  "2026-11",
  "2026-12",
  "2027-01",
  "2027-02",
  "2027-03",
  "2027-04",
];

/** Cumulative % complete, planned vs actual (actual to date only). */
export const ruiruSCurve = MONTHS.map((month, idx) => ({
  month,
  planned: PLANNED_CURVE[idx],
  actual:
    idx < ACTUAL_SHAPE.length ? Number((ACTUAL_SHAPE[idx] * ruiruProgress * 100).toFixed(1)) : null,
}));

const KIT_MONTHS = [
  "2026-05",
  "2026-06",
  "2026-07",
  "2026-08",
  "2026-09",
  "2026-10",
  "2026-11",
  "2026-12",
  "2027-01",
  "2027-02",
];
const KIT_PLANNED = [4, 14, 27, 40, 51, 55, 59, 78, 94, 100];
const KIT_ACTUAL = [4, 13, 26, 39, 50, 55, 58];

export const kitengelaSCurve = KIT_MONTHS.map((month, idx) => ({
  month,
  planned: KIT_PLANNED[idx],
  actual: KIT_ACTUAL[idx] ?? null,
}));

export const sCurveFor = (id: ProjectId) =>
  id === "ruiru-heights" ? ruiruSCurve : kitengelaSCurve;

/** Budget vs earned vs actual cost per bill, in KES millions for charting. */
export const ruiruBudgetByBill = ruiruBills.map((bill) => {
  const earned = billDoneMinor(bill);
  return {
    bill: `${bill.number}`,
    title: bill.title,
    budget: billTotalMinor(bill) / 100 / 1_000_000,
    earned: earned / 100 / 1_000_000,
    actual: (earned * bill.costFactor) / 100 / 1_000_000,
  };
});

export const ruiruActivity = [
  {
    key: "diarySubmitted",
    at: "2026-11-09T18:05:00+03:00",
    params: { date: "09/11/2026", name: people.siteAgent },
  },
  {
    key: "grnReceived",
    at: "2026-11-09T14:22:00+03:00",
    params: { grn: "GRN-0187", qty: 400, supplier: "Thika Road Hardware", lpo: "LPO-0042" },
  },
  {
    key: "voApproved",
    at: "2026-11-02T11:30:00+03:00",
    params: { vo: "VO-003", amount: "KES 1,158,000" },
  },
  {
    key: "payrollReviewed",
    at: "2026-11-10T07:15:00+03:00",
    params: { batch: "PR-2026-W45", name: people.finance },
  },
  {
    key: "inspectionPassed",
    at: "2026-11-06T10:10:00+03:00",
    params: { element: "2nd floor slab", name: people.engineer },
  },
] as const;
