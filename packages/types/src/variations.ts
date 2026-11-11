/**
 * D2.3 vocabulary: Architect's/Engineer's Instructions, Variation Orders and the company's rate
 * build-up library (brief §5.2, §15 C/G). The database CHECK constraints list the same keys, so a
 * new value needs a migration as well as a change here.
 */

/** Who issued an instruction (the consultant's discipline, not a PM-Buddy role). */
export const INSTRUCTION_ISSUER_ROLES = [
  "architect",
  "engineer",
  "quantity_surveyor",
  "client",
  "project_manager",
  "other",
] as const;
export type InstructionIssuerRole = (typeof INSTRUCTION_ISSUER_ROLES)[number];

export const INSTRUCTION_STATUSES = ["open", "closed"] as const;
export type InstructionStatus = (typeof INSTRUCTION_STATUSES)[number];

/**
 * Variation Order states (docs/WORKFLOWS.md, Variation). Transitions live in packages/domain
 * `variationTransition` and are repeated by the database trigger `app.guard_variation_order`.
 */
export const VARIATION_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type VariationStatus = (typeof VARIATION_STATUSES)[number];

/** Commands that move a variation between states. */
export const VARIATION_ACTIONS = [
  "submit",
  "approve",
  "reject",
  "reopen",
  "cancel",
  "rebase",
] as const;
export type VariationAction = (typeof VARIATION_ACTIONS)[number];

/**
 * What a variation line does to the base version: `adjust` changes an item's quantity and/or rate
 * (or, for amount-only lines, its amount); `omit` sets the item's quantity and amount to zero and
 * keeps it for history; `add` creates a new item in an existing bill, in an existing or new section.
 */
export const VARIATION_LINE_ACTIONS = ["adjust", "omit", "add"] as const;
export type VariationLineAction = (typeof VARIATION_LINE_ACTIONS)[number];

/** Why a line cannot apply to its base version (stable codes shared by the API and the web). */
export const VARIATION_LINE_ISSUES = [
  "item-not-found",
  "bill-not-found",
  "section-not-found",
  "section-not-in-bill",
  "section-required",
  "description-required",
  "kind-required",
  "unit-required",
  "quantity-and-rate-required",
  "amount-or-rate",
  "duplicate-target",
  "line-no-change",
] as const;
export type VariationLineIssue = (typeof VARIATION_LINE_ISSUES)[number];

/** Item classes a variation may add (attendance and profit lines belong to their PC sum). */
export const VARIATION_ADD_KINDS = [
  "measured",
  "preliminary",
  "provisional_sum",
  "pc_sum",
  "contingency",
  "daywork",
] as const;
export type VariationAddKind = (typeof VARIATION_ADD_KINDS)[number];

export const VARIATION_LIMITS = {
  maxLines: 500,
  maxAttachments: 10,
  maxNumberLength: 30,
} as const;

/** Resource classes of a rate build-up line (ERD RateBuildUpComponent.kind). */
export const BUILDUP_RESOURCE_KINDS = ["material", "labour", "plant"] as const;
export type BuildupResourceKind = (typeof BUILDUP_RESOURCE_KINDS)[number];

/**
 * Build-up quantities are exact decimals with up to six places (FINANCIAL_MODEL proposes scale
 * 6 for quantities); waste is a percentage with up to four places, 0–100.
 */
export const BUILDUP_LIMITS = {
  maxLines: 50,
  quantityScale: 6,
  wasteScale: 4,
  maxWastePercent: 100,
} as const;

/**
 * Units a build-up can be priced per (the BQ's normalised units without `pct`, which is not a
 * unit of work, and `other`, which cannot be compared).
 */
export const BUILDUP_OUTPUT_UNITS = [
  "m3",
  "m2",
  "m",
  "kg",
  "t",
  "nr",
  "item",
  "ls",
  "hr",
  "day",
  "week",
  "month",
  "l",
  "set",
  "pair",
] as const;
export type BuildupOutputUnit = (typeof BUILDUP_OUTPUT_UNITS)[number];

/** How a build-up rate is rounded (`bq.buildup.rounding`): each resource line half-up to the cent. */
export const BUILDUP_ROUNDING = "half_up_line" as const;
