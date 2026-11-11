/**
 * Project vocabulary shared by web, API and database (D2.1). The database CHECK constraints list
 * the same keys, so adding a value needs a migration as well as a change here.
 */

/**
 * Kenya's 47 counties, in the official order of the Constitution's First Schedule. `name` is the
 * official spelling; it is used unchanged in English and Kiswahili because it is a proper name.
 */
export const KENYA_COUNTIES = [
  { code: 1, key: "mombasa", name: "Mombasa" },
  { code: 2, key: "kwale", name: "Kwale" },
  { code: 3, key: "kilifi", name: "Kilifi" },
  { code: 4, key: "tana-river", name: "Tana River" },
  { code: 5, key: "lamu", name: "Lamu" },
  { code: 6, key: "taita-taveta", name: "Taita-Taveta" },
  { code: 7, key: "garissa", name: "Garissa" },
  { code: 8, key: "wajir", name: "Wajir" },
  { code: 9, key: "mandera", name: "Mandera" },
  { code: 10, key: "marsabit", name: "Marsabit" },
  { code: 11, key: "isiolo", name: "Isiolo" },
  { code: 12, key: "meru", name: "Meru" },
  { code: 13, key: "tharaka-nithi", name: "Tharaka-Nithi" },
  { code: 14, key: "embu", name: "Embu" },
  { code: 15, key: "kitui", name: "Kitui" },
  { code: 16, key: "machakos", name: "Machakos" },
  { code: 17, key: "makueni", name: "Makueni" },
  { code: 18, key: "nyandarua", name: "Nyandarua" },
  { code: 19, key: "nyeri", name: "Nyeri" },
  { code: 20, key: "kirinyaga", name: "Kirinyaga" },
  { code: 21, key: "muranga", name: "Murang'a" },
  { code: 22, key: "kiambu", name: "Kiambu" },
  { code: 23, key: "turkana", name: "Turkana" },
  { code: 24, key: "west-pokot", name: "West Pokot" },
  { code: 25, key: "samburu", name: "Samburu" },
  { code: 26, key: "trans-nzoia", name: "Trans Nzoia" },
  { code: 27, key: "uasin-gishu", name: "Uasin Gishu" },
  { code: 28, key: "elgeyo-marakwet", name: "Elgeyo-Marakwet" },
  { code: 29, key: "nandi", name: "Nandi" },
  { code: 30, key: "baringo", name: "Baringo" },
  { code: 31, key: "laikipia", name: "Laikipia" },
  { code: 32, key: "nakuru", name: "Nakuru" },
  { code: 33, key: "narok", name: "Narok" },
  { code: 34, key: "kajiado", name: "Kajiado" },
  { code: 35, key: "kericho", name: "Kericho" },
  { code: 36, key: "bomet", name: "Bomet" },
  { code: 37, key: "kakamega", name: "Kakamega" },
  { code: 38, key: "vihiga", name: "Vihiga" },
  { code: 39, key: "bungoma", name: "Bungoma" },
  { code: 40, key: "busia", name: "Busia" },
  { code: 41, key: "siaya", name: "Siaya" },
  { code: 42, key: "kisumu", name: "Kisumu" },
  { code: 43, key: "homa-bay", name: "Homa Bay" },
  { code: 44, key: "migori", name: "Migori" },
  { code: 45, key: "kisii", name: "Kisii" },
  { code: 46, key: "nyamira", name: "Nyamira" },
  { code: 47, key: "nairobi", name: "Nairobi City" },
] as const;

export type County = (typeof KENYA_COUNTIES)[number]["key"];
export const COUNTY_KEYS = KENYA_COUNTIES.map((county) => county.key) as [County, ...County[]];

export const countyName = (key: County): string =>
  KENYA_COUNTIES.find((county) => county.key === key)?.name ?? key;

/**
 * How the contract price is determined (ERD §3). The form of contract (JBC, FIDIC, PPRA) is a
 * separate attribute that arrives with the commercial modules.
 * - lump_sum: fixed price for the described works (typical JBC lump-sum contracts).
 * - remeasurement: BQ quantities are remeasured and valued at the tendered rates.
 * - design_and_build: the contractor designs and builds for an agreed price.
 * - cost_plus: actual cost reimbursed plus an agreed fee or percentage.
 * - labour_only: the client supplies materials; the contractor provides labour and supervision.
 */
export const CONTRACT_TYPES = [
  "lump_sum",
  "remeasurement",
  "design_and_build",
  "cost_plus",
  "labour_only",
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

/** Project lifecycle states (brief §15 C). Transitions live in packages/domain project-lifecycle. */
export const PROJECT_STATUSES = [
  "planning",
  "active",
  "on_hold",
  "completed",
  "closed",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Milestone states. Transitions live in packages/domain project-lifecycle. */
export const MILESTONE_STATUSES = ["planned", "in_progress", "achieved", "cancelled"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/** Geofence shapes (ERD §3 Geofence.kind). */
export const GEOFENCE_KINDS = ["radius", "polygon"] as const;
export type GeofenceKind = (typeof GEOFENCE_KINDS)[number];
