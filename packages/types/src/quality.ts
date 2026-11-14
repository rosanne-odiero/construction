import type { Permission } from "./permissions.js";

/**
 * Quality vocabulary (D6.1, brief §5.9 and §15 C/G; ARCHITECTURE §4.7; WORKFLOWS "Quality").
 * The database CHECK constraints and triggers in migration `20261122100000_quality` list the same
 * values, so adding one needs a migration as well as a change here.
 */

/** What a checklist template (and the inspections made from it) covers. */
export const INSPECTION_CATEGORIES = [
  "setting_out",
  "excavation",
  "foundations",
  "blockwork",
  "columns_beams",
  "slab",
  "roofing",
  "plumbing",
  "electrical",
  "finishes",
  "handover",
  "other",
] as const;
export type InspectionCategory = (typeof INSPECTION_CATEGORIES)[number];

/** Who inspected: the contractor's own staff, the client's consultant, or the county inspector. */
export const INSPECTOR_TYPES = ["internal", "consultant", "county"] as const;
export type InspectorType = (typeof INSPECTOR_TYPES)[number];

/**
 * An inspection: draft (being filled in by its author) → submitted → signed off (locked) by an
 * independent `quality.manage` holder, or returned to draft with a reason.
 */
export const INSPECTION_STATUSES = ["draft", "submitted", "signed_off"] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];
export const INSPECTION_ACTIONS = ["submit", "sign_off", "return"] as const;
export type InspectionAction = (typeof INSPECTION_ACTIONS)[number];

/** A checklist item's answer; `pending` items block submission. */
export const INSPECTION_ITEM_RESULTS = ["pending", "pass", "fail", "na"] as const;
export type InspectionItemResult = (typeof INSPECTION_ITEM_RESULTS)[number];
/** An inspection fails when any item fails; it passes when every item passed or is N/A. */
export const INSPECTION_RESULTS = ["pass", "fail"] as const;
export type InspectionResult = (typeof INSPECTION_RESULTS)[number];

/**
 * Concrete classes as used on Kenyan sites: the number is the characteristic 28-day CUBE
 * strength f_cu in N/mm² (the BS 8110 / BS 5328 convention). Under BS EN 206 "C25/30" the
 * cube value is the second number, so an engineer must confirm the notation for each project
 * (COMPLIANCE-REVIEW CR-QA-01).
 */
export const CONCRETE_CLASSES = [
  "C10",
  "C15",
  "C20",
  "C25",
  "C30",
  "C35",
  "C40",
  "C45",
  "C50",
] as const;
export type ConcreteClass = (typeof CONCRETE_CLASSES)[number];

/** Ages (days after casting) at which cubes are crushed. */
export const CUBE_TEST_AGES = [7, 28] as const;
export type CubeTestAge = (typeof CUBE_TEST_AGES)[number];

/**
 * The cube compliance rule `KE-CUBE-1` (COMPLIANCE-REVIEW CR-QA-01, for a structural engineer):
 * - 28 days decides: a set passes when the mean of its cubes is at least f_cu AND no cube is
 *   below f_cu − 3 N/mm² (after the BS 5328-4 individual criterion for C20 and above).
 * - 7 days is indicative only, never pass or fail: a mean below 65 % of f_cu is flagged "low"
 *   (a site rule of thumb for ordinary Portland cement; slower cements gain strength later).
 * Results store the rule version they were judged with, so a later rule never changes them.
 */
export const CUBE_RULE = {
  version: "KE-CUBE-1",
  individualMarginNmm2: 3,
  sevenDayIndicativePercent: 65,
} as const;
/** Outcomes: 28-day results pass or fail; 7-day results are indicative (ok or low). */
export const CUBE_OUTCOMES = ["pass", "fail", "indicative_ok", "indicative_low"] as const;
export type CubeOutcome = (typeof CUBE_OUTCOMES)[number];
/** A cube set is active, or void (entered in error, with a reason); void sets are never due. */
export const CUBE_SET_STATUSES = ["active", "void"] as const;
export type CubeSetStatus = (typeof CUBE_SET_STATUSES)[number];
/** Where a set's result at one age stands. */
export const CUBE_AGE_STATES = ["not_due", "due", "overdue", "recorded"] as const;
export type CubeAgeState = (typeof CUBE_AGE_STATES)[number];

/**
 * The slump rule `KE-SLUMP-1` (COMPLIANCE-REVIEW CR-QA-02): a test passes when the measured
 * slump is within the tolerance of the target, both in mm. The suggested tolerance follows the
 * BS EN 206 tolerances for target slump values: ±10 mm below 50 mm, ±20 mm from 50 to 99 mm and
 * ±30 mm from 100 mm; the recorder may enter the specification's own tolerance.
 */
export const SLUMP_RULE = {
  version: "KE-SLUMP-1",
  bands: [
    { belowMm: 50, toleranceMm: 10 },
    { belowMm: 100, toleranceMm: 20 },
  ],
  otherwiseToleranceMm: 30,
} as const;
export const SLUMP_OUTCOMES = ["pass", "fail"] as const;
export type SlumpOutcome = (typeof SLUMP_OUTCOMES)[number];

/** Snag severity; open critical snags block practical completion unless excepted with a reason. */
export const SNAG_SEVERITIES = ["critical", "major", "minor"] as const;
export type SnagSeverity = (typeof SNAG_SEVERITIES)[number];
/** Who must fix a snag (free text names it until subcontracts exist, D6.3). */
export const SNAG_RESPONSIBLE_KINDS = ["gang", "subcontractor", "supplier", "other"] as const;
export type SnagResponsibleKind = (typeof SNAG_RESPONSIBLE_KINDS)[number];
/**
 * A snag is open → fixed (recorded for the responsible party) → closed (verified by an
 * independent `quality.manage` holder), or reopened (back to open, with a reason). Closed is final.
 */
export const SNAG_STATUSES = ["open", "fixed", "closed"] as const;
export type SnagStatus = (typeof SNAG_STATUSES)[number];
export const SNAG_ACTIONS = ["fix", "close", "reopen"] as const;
export type SnagAction = (typeof SNAG_ACTIONS)[number];
/** Raised before practical completion, or reported during the defects liability period. */
export const SNAG_PHASES = ["construction", "dlp"] as const;
export type SnagPhase = (typeof SNAG_PHASES)[number];

/**
 * Completion certificates: practical completion (starts the defects liability period) and final
 * completion (the end of the DLP once defects are made good; D6.3 releases retention against
 * both). Each is proposed, then certified by an independent `quality.manage` holder (locked), or
 * withdrawn with a reason.
 */
export const COMPLETION_KINDS = ["practical", "final"] as const;
export type CompletionKind = (typeof COMPLETION_KINDS)[number];
export const COMPLETION_STATUSES = ["proposed", "certified", "withdrawn"] as const;
export type CompletionStatus = (typeof COMPLETION_STATUSES)[number];
export const COMPLETION_ACTIONS = ["certify", "withdraw"] as const;
export type CompletionAction = (typeof COMPLETION_ACTIONS)[number];

/**
 * Company defaults (CONFIGURATION "Quality"): the defects liability period is 6 months unless the contract
 * says otherwise (the usual JBC default; COMPLIANCE-REVIEW CR-QA-03) and can be 1–24 months per
 * project; a cube result is overdue 2 days after it fell due.
 */
export const DEFAULT_QUALITY_SETTINGS = { dlpMonths: 6, cubeOverdueGraceDays: 2 } as const;
export const QUALITY_SETTINGS_LIMITS = {
  dlpMonths: { min: 1, max: 24 },
  cubeOverdueGraceDays: { min: 0, max: 14 },
} as const;

/** How a diary's workforce was recorded (D6.1): typed in, or a snapshot of attendance. */
export const WORKFORCE_SOURCES = ["manual", "attendance"] as const;
export type WorkforceSource = (typeof WORKFORCE_SOURCES)[number];
/** The muster sheet's state when the snapshot was taken (`none`: no muster that day). */
export const WORKFORCE_MUSTER_STATES = ["none", "draft", "submitted", "confirmed"] as const;
export type WorkforceMusterState = (typeof WORKFORCE_MUSTER_STATES)[number];

/**
 * Who may read inspections, tests, snags and completion (on top of `projects.view`): the
 * contractor's staff and the consultant. Portal-only roles (client, supplier) hold none of these.
 */
export const QUALITY_READ_PERMISSIONS = [
  "quality.manage",
  "site.diary",
  "site.photos",
  "projects.manage",
  "reports.view",
  "safety.manage",
] as const satisfies readonly Permission[];
/** Who may record inspections, cube and slump tests, raise snags and record a snag as fixed. */
export const QUALITY_RECORD_PERMISSIONS = [
  "quality.manage",
  "site.diary",
] as const satisfies readonly Permission[];

export const QUALITY_LIMITS = {
  /** Items on one checklist template version (and so on one inspection). */
  maxTemplateItems: 60,
  maxTemplateItemChars: 300,
  /** Cubes crushed at one age (a set is usually 3 per age). */
  maxCubesPerAge: 6,
  /** N/mm², one decimal place. */
  maxCubeStrength: 150,
  maxSlumpMm: 300,
  maxSlumpTargetMm: 250,
  maxSlumpToleranceMm: 60,
  /** Photos linked to one checklist item or one snag stage. */
  maxPhotosPerItem: 6,
  /** Rows per list page. */
  maxPageSize: 100,
} as const;

export type StarterChecklistTemplate = {
  key: string;
  category: InspectionCategory;
  name: { en: string; sw: string };
  items: readonly { en: string; sw: string }[];
};

/**
 * Starter checklist templates a company can load (synthetic defaults, written for small Kenyan
 * building sites; a company revises them to its own specification). The Kiswahili wording needs a
 * native speaker's and a site engineer's review.
 */
export const STARTER_CHECKLIST_TEMPLATES: readonly StarterChecklistTemplate[] = [
  {
    key: "setting_out",
    category: "setting_out",
    name: { en: "Setting out", sw: "Upimaji na uwekaji alama" },
    items: [
      {
        en: "Boundary beacons found and confirmed against the survey plan",
        sw: "Vigingi vya mipaka vimepatikana na kuthibitishwa dhidi ya ramani ya upimaji",
      },
      {
        en: "Building lines and offsets checked against the approved drawings",
        sw: "Mistari ya jengo na umbali vimekaguliwa dhidi ya michoro iliyoidhinishwa",
      },
      {
        en: "Diagonals checked: the building is square within 10 mm",
        sw: "Mistari ya pembe imekaguliwa: jengo liko mraba ndani ya mm 10",
      },
      {
        en: "Profile boards firm and levels transferred from the datum",
        sw: "Mbao za alama ni imara na viwango vimehamishwa kutoka alama ya msingi",
      },
      {
        en: "Setting out approved before excavation starts",
        sw: "Upimaji umeidhinishwa kabla ya kuanza kuchimba",
      },
    ],
  },
  {
    key: "foundations",
    category: "foundations",
    name: { en: "Foundations before concreting", sw: "Msingi kabla ya kumwaga zege" },
    items: [
      {
        en: "Trench width and depth as drawn; the bottom is firm and level",
        sw: "Upana na kina cha mtaro ni kama mchoro; sakafu ya mtaro ni imara na sawa",
      },
      {
        en: "Soft spots and loose material removed",
        sw: "Sehemu laini na udongo uliolegea vimeondolewa",
      },
      {
        en: "Blinding laid to the specified thickness",
        sw: "Zege ya chini (blinding) imewekwa kwa unene uliobainishwa",
      },
      {
        en: "Reinforcement sizes, spacing and laps as drawn",
        sw: "Ukubwa, nafasi na miingiliano ya nondo ni kama mchoro",
      },
      { en: "Cover spacers in place", sw: "Vishikizi vya kufunika nondo vipo" },
      {
        en: "Anti-termite treatment applied before concreting",
        sw: "Dawa ya mchwa imewekwa kabla ya kumwaga zege",
      },
    ],
  },
  {
    key: "slab",
    category: "slab",
    name: { en: "Suspended slab before casting", sw: "Sakafu ya juu kabla ya kumwaga zege" },
    items: [
      {
        en: "Formwork level, propped and braced",
        sw: "Fomu iko sawa, imeegemezwa na kuimarishwa",
      },
      {
        en: "Formwork joints tight and cleaned out",
        sw: "Viungo vya fomu vimebana na vimesafishwa",
      },
      {
        en: "Reinforcement as the bar schedule: sizes, spacing and laps",
        sw: "Nondo kulingana na ratiba ya nondo: ukubwa, nafasi na miingiliano",
      },
      {
        en: "Cover blocks and chairs fixed",
        sw: "Vishikizi na viti vya nondo vimewekwa",
      },
      {
        en: "Conduits and sleeves for services in place",
        sw: "Mabomba ya nyaya na mikono ya huduma yamewekwa",
      },
      {
        en: "Cube moulds and slump cone on site for the pour",
        sw: "Vyombo vya cube na koni ya slump vipo kwa ajili ya kumwaga",
      },
    ],
  },
  {
    key: "blockwork",
    category: "blockwork",
    name: { en: "Walling", sw: "Ujenzi wa kuta" },
    items: [
      { en: "Walls plumb and true to line", sw: "Kuta zimesimama wima na zimenyooka" },
      {
        en: "Mortar joints full and of even thickness",
        sw: "Viungo vya chokaa vimejaa na vina unene sawa",
      },
      {
        en: "Hoop iron at the specified courses",
        sw: "Chuma cha hoop kimewekwa kwenye safu zilizobainishwa",
      },
      {
        en: "Lintels over openings with the required bearing",
        sw: "Linta juu ya nafasi zina uegemeo unaohitajika",
      },
      {
        en: "Damp-proof course laid and lapped",
        sw: "Kizuia unyevu (DPC) kimewekwa na kuingiliana",
      },
    ],
  },
  {
    key: "roofing",
    category: "roofing",
    name: { en: "Roofing", sw: "Paa" },
    items: [
      {
        en: "Wall plate anchored to the ring beam",
        sw: "Mbao ya ukuta imefungwa kwenye boriti ya pete",
      },
      {
        en: "Trusses at the specified spacing, braced and treated",
        sw: "Trasi ziko kwenye nafasi iliyobainishwa, zimeimarishwa na kutibiwa",
      },
      {
        en: "Purlins fixed with the specified fasteners",
        sw: "Purlini zimefungwa kwa vifungo vilivyobainishwa",
      },
      {
        en: "Roofing sheets lapped and fixed as the manufacturer requires",
        sw: "Mabati yameingiliana na kufungwa kama mtengenezaji anavyotaka",
      },
      {
        en: "Ridge, valleys and flashings watertight",
        sw: "Kilele, mabonde na flashing havivuji",
      },
      {
        en: "Gutters and downpipes fixed to falls",
        sw: "Mifereji na mabomba ya mvua yamefungwa kwa mteremko",
      },
    ],
  },
  {
    key: "plumbing",
    category: "plumbing",
    name: { en: "Plumbing first fix", sw: "Mabomba: hatua ya kwanza" },
    items: [
      { en: "Pipe sizes and routes as drawn", sw: "Ukubwa na njia za mabomba ni kama mchoro" },
      {
        en: "Pressure test held without loss",
        sw: "Jaribio la shinikizo limeshikilia bila kupungua",
      },
      { en: "Drainage falls checked", sw: "Mteremko wa mifereji ya maji taka umekaguliwa" },
      {
        en: "Pipes supported and sleeved through walls",
        sw: "Mabomba yameshikiliwa na yana mikono kupitia kuta",
      },
    ],
  },
  {
    key: "handover",
    category: "handover",
    name: { en: "Pre-handover", sw: "Kabla ya kukabidhi" },
    items: [
      {
        en: "Doors and windows open, close and lock",
        sw: "Milango na madirisha yanafunguka, yanafungika na yanafungwa kwa kufuli",
      },
      {
        en: "Finishes complete and undamaged",
        sw: "Umaliziaji umekamilika bila uharibifu",
      },
      {
        en: "Electrical installation tested and its certificate on file",
        sw: "Mfumo wa umeme umejaribiwa na cheti chake kipo",
      },
      {
        en: "Plumbing fittings work without leaks",
        sw: "Vifaa vya mabomba vinafanya kazi bila kuvuja",
      },
      {
        en: "Site cleared of debris and surplus materials",
        sw: "Eneo limesafishwa takataka na vifaa vya ziada",
      },
    ],
  },
];
