import type { BiometricConsentStatus, BiometricEnrolmentState, DpiaState } from "@pm-buddy/types";
import type { CreateDpiaRequest, DpiaDetail } from "@pm-buddy/validation";
import type { Tone } from "@/components/status-badge";
import { calendarInput, parseCalendarInput } from "./project-input";

/**
 * Biometric attendance gate helpers for the live pages (D3.4). The API decides everything; these
 * only shape the form and choose badge tones.
 */

export const dpiaStateTone: Record<DpiaState, Tone> = {
  draft: "info",
  in_force: "success",
  lapsed: "warning",
  rejected: "neutral",
  superseded: "neutral",
  withdrawn: "danger",
};

export const enrolmentStateTone: Record<BiometricEnrolmentState, Tone> = {
  active: "success",
  held: "warning",
  deletion_due: "warning",
  deleted: "neutral",
};

export const consentStatusTone: Record<BiometricConsentStatus, Tone> = {
  none: "neutral",
  granted: "success",
  refused: "neutral",
  withdrawn: "warning",
};

/** Fills a biometric notice's placeholders with the company, retention period and DPO. */
export function fillNotice(
  text: string,
  values: { company: string; retentionDays: number; dpoName: string; dpoPhone: string },
): string {
  return text
    .replaceAll("{company}", values.company)
    .replaceAll("{retentionDays}", String(values.retentionDays))
    .replaceAll("{dpoName}", values.dpoName)
    .replaceAll("{dpoPhone}", values.dpoPhone);
}

/** The first characters of a SHA-256, for display next to the full value. */
export const shortHash = (sha256: string) => sha256.slice(0, 12);

/** The draft editor's state: dates as typed (DD/MM/YYYY), empty strings for missing text. */
export type DpiaFormState = {
  methods: string[];
  siteIds: string[];
  dpoName: string;
  dpoPhone: string;
  dpoOpinion: string;
  dpoOpinionOn: string;
  dpoNote: string;
  controllerName: string;
  controllerRole: string;
  controllerDecision: string;
  controllerDecisionOn: string;
  controllerNote: string;
  residualRisk: string;
  odpcReference: string;
};

export function dpiaFormState(dpia: DpiaDetail): DpiaFormState {
  return {
    methods: [...dpia.methods],
    siteIds: dpia.sites.map((site) => site.id),
    dpoName: dpia.dpo.name ?? "",
    dpoPhone: dpia.dpo.phone ?? "",
    dpoOpinion: dpia.dpo.opinion ?? "",
    dpoOpinionOn: calendarInput(dpia.dpo.opinionOn),
    dpoNote: dpia.dpo.note ?? "",
    controllerName: dpia.controller.name ?? "",
    controllerRole: dpia.controller.role ?? "",
    controllerDecision: dpia.controller.decision ?? "",
    controllerDecisionOn: calendarInput(dpia.controller.decisionOn),
    controllerNote: dpia.controller.note ?? "",
    residualRisk: dpia.residualRisk ?? "",
    odpcReference: dpia.odpcReference ?? "",
  };
}

/** The request body for the form, or null while a typed date is not DD/MM/YYYY. */
export function dpiaRequest(form: DpiaFormState): Record<string, unknown> | null {
  const dpoOpinionOn = parseCalendarInput(form.dpoOpinionOn);
  const controllerDecisionOn = parseCalendarInput(form.controllerDecisionOn);
  if (dpoOpinionOn === undefined || controllerDecisionOn === undefined) return null;
  return {
    methods: form.methods,
    siteIds: form.siteIds,
    dpoName: form.dpoName,
    dpoPhone: form.dpoPhone,
    dpoOpinion: form.dpoOpinion || null,
    dpoOpinionOn,
    dpoNote: form.dpoNote,
    controllerName: form.controllerName,
    controllerRole: form.controllerRole,
    controllerDecision: form.controllerDecision || null,
    controllerDecisionOn,
    controllerNote: form.controllerNote,
    residualRisk: form.residualRisk || null,
    odpcReference: form.odpcReference,
  };
}

/**
 * A renewal starts from the DPIA in force: the same methods, sites, names, DPO phone and residual
 * risk. The
 * opinion, the decision and their dates and notes are left empty: they must be signed again.
 */
export function renewalRequest(current: DpiaDetail | null): CreateDpiaRequest {
  return {
    methods: current ? [...current.methods] : [],
    siteIds: current ? current.sites.map((site) => site.id) : [],
    dpoName: current?.dpo.name ?? null,
    dpoPhone: current?.dpo.phone ?? null,
    dpoOpinion: null,
    dpoOpinionOn: null,
    dpoNote: null,
    controllerName: current?.controller.name ?? null,
    controllerRole: current?.controller.role ?? null,
    controllerDecision: null,
    controllerDecisionOn: null,
    controllerNote: null,
    residualRisk: current?.residualRisk ?? null,
    odpcReference: null,
  };
}
