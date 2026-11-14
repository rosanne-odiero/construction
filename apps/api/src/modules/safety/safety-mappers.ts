import {
  correctiveActionDaysOverdue,
  correctiveActionOverdue,
  correctiveActionVerifierIndependent,
  certificateState,
  incidentCloseBlockers,
  inductionValidUntil,
  kitNextCheckOn,
  kitState,
  nairobiDate,
  ppeReplacementState,
  regulatorState,
} from "@pm-buddy/domain";
import type {
  CorrectiveActionStatus,
  IncidentKind,
  IncidentSeverity,
  IncidentStatus,
  InductionTopic,
  RegulatorDecision,
} from "@pm-buddy/types";
import {
  correctiveActionSchema,
  firstAiderSchema,
  firstAidKitSchema,
  incidentSchema,
  inductionSchema,
  ppeIssueSchema,
  toolboxTalkSchema,
  toolboxTalkSummarySchema,
  treatmentSchema,
  type CorrectiveAction,
  type FirstAider,
  type FirstAidKit,
  type Incident,
  type Induction,
  type PpeIssue,
  type SafetyLabourer,
  type ToolboxTalk,
  type ToolboxTalkSummary,
  type Treatment,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { personOf, type People } from "../procurement/procurement-mappers.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import { labourerOf, recordCode, type SafetyContext } from "./safety-access.js";

const optionalPerson = (people: People, id: string | null) => (id ? personOf(people, id) : null);
const iso = (value: Date | null) => value?.toISOString() ?? null;
const date = (value: Date | null) => (value ? toCalendarDate(value) : null);
type Labourers = Map<string, SafetyLabourer>;
const photoSelect = { select: { id: true, verified: true, caption: true } } as const;
const toPhoto = (photo: { id: string; verified: boolean; caption: string | null }) => ({
  id: photo.id,
  verified: photo.verified,
  caption: photo.caption,
});

// Inductions ------------------------------------------------------------------------------------

export const inductionInclude = { site: { select: { name: true } } } as const;
export type InductionRow = Prisma.SafetyInductionGetPayload<{ include: typeof inductionInclude }>;
export const inductionPeople = (row: InductionRow) => [
  row.userId,
  row.inductorId,
  row.recordedBy,
  row.voidedBy,
];

export function toInduction(
  row: InductionRow,
  people: People,
  labourers: Labourers,
  context: SafetyContext,
  validityDays: number | null,
): Induction {
  const inductedOn = toCalendarDate(row.inductedOn);
  const validUntil = inductionValidUntil(inductedOn, validityDays);
  const recorded = row.status === "recorded";
  return inductionSchema.parse({
    id: row.id,
    projectId: row.projectId,
    siteId: row.siteId,
    siteName: row.site.name,
    number: row.number,
    code: recordCode("IND", row.number),
    personKind: row.personKind,
    labourer: row.labourerId ? labourerOf(labourers, row.labourerId) : null,
    staff: optionalPerson(people, row.userId),
    visitorName: row.visitorName,
    visitorOrganisation: row.visitorOrganisation,
    inductedOn,
    validUntil,
    state: !recorded
      ? "none"
      : validUntil === null || nairobiDate() <= validUntil
        ? "valid"
        : "expired",
    inductor: personOf(people, row.inductorId),
    topics: row.topics as InductionTopic[],
    topicsTotal: row.topicsTotal,
    acknowledgement: row.acknowledgement,
    notes: row.notes,
    status: row.status,
    recordedBy: personOf(people, row.recordedBy),
    recordedAt: row.recordedAt.toISOString(),
    voidedBy: optionalPerson(people, row.voidedBy),
    voidedAt: iso(row.voidedAt),
    voidReason: row.voidReason,
    version: row.version,
    permissions: { canVoid: context.canManage && recorded },
  });
}

// Toolbox talks ---------------------------------------------------------------------------------

export const talkInclude = {
  site: { select: { name: true } },
  photo: photoSelect,
  _count: { select: { attendees: true } },
} as const;
export type TalkRow = Prisma.ToolboxTalkGetPayload<{ include: typeof talkInclude }>;
export const talkPeople = (row: TalkRow) => [
  row.presenterId,
  row.createdBy,
  row.confirmedBy,
  row.cancelledBy,
];

export function toTalkSummary(
  row: TalkRow,
  people: People,
  context: SafetyContext,
): ToolboxTalkSummary {
  const draft = row.status === "draft";
  return toolboxTalkSummarySchema.parse({
    id: row.id,
    projectId: row.projectId,
    siteId: row.siteId,
    siteName: row.site.name,
    number: row.number,
    code: recordCode("TBT", row.number),
    heldOn: toCalendarDate(row.heldOn),
    topic: row.topic,
    notes: row.notes,
    durationMinutes: row.durationMinutes,
    presenter: personOf(people, row.presenterId),
    photo: row.photo ? toPhoto(row.photo) : null,
    otherAttendees: row.otherAttendees,
    attendeeCount: row._count.attendees,
    status: row.status,
    createdBy: personOf(people, row.createdBy),
    createdAt: row.createdAt.toISOString(),
    confirmedBy: optionalPerson(people, row.confirmedBy),
    confirmedAt: iso(row.confirmedAt),
    cancelledBy: optionalPerson(people, row.cancelledBy),
    cancelledAt: iso(row.cancelledAt),
    cancelReason: row.cancelReason,
    version: row.version,
    permissions: {
      canEdit: context.canRecord && draft,
      canConfirm: context.canRecord && draft,
      canCancel: context.canRecord && draft,
      canRaiseAction: context.canManage && row.status === "confirmed",
    },
  });
}

export function toTalk(
  row: TalkRow,
  attendees: { labourerId: string; viaGang: { id: string; name: string } | null }[],
  people: People,
  labourers: Labourers,
  context: SafetyContext,
): ToolboxTalk {
  return toolboxTalkSchema.parse({
    ...toTalkSummary(row, people, context),
    attendees: attendees.map((attendee) => ({
      labourer: labourerOf(labourers, attendee.labourerId),
      gang: attendee.viaGang,
    })),
  });
}

// PPE -------------------------------------------------------------------------------------------

export const ppeInclude = { site: { select: { name: true } } } as const;
export type PpeRow = Prisma.PpeIssueGetPayload<{ include: typeof ppeInclude }>;
export const ppePeople = (row: PpeRow) => [row.issuedBy, row.returnedBy, row.voidedBy];

export function toPpeIssue(
  row: PpeRow,
  people: People,
  labourers: Labourers,
  context: SafetyContext,
): PpeIssue {
  const issued = row.status === "issued";
  const dueOn = toCalendarDate(row.replacementDueOn);
  return ppeIssueSchema.parse({
    id: row.id,
    projectId: row.projectId,
    siteId: row.siteId,
    siteName: row.site.name,
    labourer: labourerOf(labourers, row.labourerId),
    item: row.item,
    size: row.size,
    quantity: row.quantity,
    issuedOn: toCalendarDate(row.issuedOn),
    replacementDueOn: dueOn,
    replacementState: issued ? ppeReplacementState(dueOn, nairobiDate()) : null,
    status: row.status,
    returnedOn: date(row.returnedOn),
    returnCondition: row.returnCondition,
    replacesIssueId: row.replacesIssueId,
    issuedBy: personOf(people, row.issuedBy),
    issuedAt: row.issuedAt.toISOString(),
    returnedBy: optionalPerson(people, row.returnedBy),
    voidedBy: optionalPerson(people, row.voidedBy),
    voidedAt: iso(row.voidedAt),
    voidReason: row.voidReason,
    version: row.version,
    permissions: {
      canReturn: context.canRecord && issued,
      canReplace: context.canRecord && issued,
      canVoid: context.canManage && issued,
    },
  });
}

// Incidents -------------------------------------------------------------------------------------

export const incidentInclude = {
  site: { select: { name: true } },
  // Injured, then involved, then witnesses.
  people: {
    orderBy: [{ role: "asc" as const }, { addedAt: "asc" as const }, { id: "asc" as const }],
  },
  photos: { include: { photo: photoSelect }, orderBy: { addedAt: "asc" as const } },
  correctiveActions: { select: { status: true, dueOn: true } },
  followUpOf: { select: { id: true, number: true } },
} satisfies Prisma.SafetyIncidentInclude;
export type IncidentRow = Prisma.SafetyIncidentGetPayload<{ include: typeof incidentInclude }>;
export const incidentPeople = (row: IncidentRow) => [
  row.reportedBy,
  row.investigatedBy,
  row.regulatorDecidedBy,
  row.closedBy,
  row.voidedBy,
  ...row.people.map((person) => person.userId),
];
export const incidentLabourers = (row: IncidentRow) =>
  row.people.map((person) => person.labourerId);

export function toIncident(
  row: IncidentRow,
  people: People,
  labourers: Labourers,
  context: SafetyContext,
): Incident {
  const today = nairobiDate();
  const status = row.status as IncidentStatus;
  const open = status === "reported" || status === "investigated";
  const actions = row.correctiveActions.map((action) => ({
    status: action.status as CorrectiveActionStatus,
    dueOn: toCalendarDate(action.dueOn),
  }));
  const kind = row.kind as IncidentKind;
  const severity = row.severity as IncidentSeverity;
  const decision = row.regulatorDecision as RegulatorDecision | null;
  const blockers = open
    ? incidentCloseBlockers({ status, kind, severity, regulatorDecision: decision }, actions, null)
    : [];
  const roleCount = (role: string) => row.people.filter((person) => person.role === role).length;
  const count = (wanted: CorrectiveActionStatus) =>
    actions.filter((action) => action.status === wanted).length;
  return incidentSchema.parse({
    id: row.id,
    projectId: row.projectId,
    siteId: row.siteId,
    siteName: row.site.name,
    number: row.number,
    code: recordCode("INC", row.number),
    kind,
    severity,
    occurredAt: row.occurredAt.toISOString(),
    location: row.location,
    description: row.description,
    immediateActions: row.immediateActions,
    firstAidGiven: row.firstAidGiven,
    people: context.canSeePersonal
      ? row.people.map((person) => ({
          id: person.id,
          role: person.role,
          labourer: person.labourerId ? labourerOf(labourers, person.labourerId) : null,
          staff: optionalPerson(people, person.userId),
          name: person.name,
          injuryType: person.injuryType,
          bodyPart: person.bodyPart,
        }))
      : null,
    peopleCounts: {
      injured: roleCount("injured"),
      involved: roleCount("involved"),
      witness: roleCount("witness"),
    },
    photos: row.photos.map((link) => toPhoto(link.photo)),
    status,
    reportedBy: personOf(people, row.reportedBy),
    reportedAt: row.reportedAt.toISOString(),
    investigation:
      row.rootCause && row.rootCauseCategory && row.investigatedBy && row.investigatedAt
        ? {
            rootCauseCategory: row.rootCauseCategory,
            rootCause: row.rootCause,
            contributingFactors: row.contributingFactors,
            investigatedBy: personOf(people, row.investigatedBy),
            investigatedAt: row.investigatedAt.toISOString(),
          }
        : null,
    regulator: {
      state: regulatorState(kind, severity, decision),
      notifiedOn: date(row.regulatorNotifiedOn),
      reference: row.regulatorReference,
      reason: row.regulatorReason,
      decidedBy: optionalPerson(people, row.regulatorDecidedBy),
      decidedAt: iso(row.regulatorDecidedAt),
    },
    actionCounts: {
      open: count("open"),
      overdue: actions.filter((action) => correctiveActionOverdue(action, today)).length,
      done: count("done"),
      verified: count("verified"),
      cancelled: count("cancelled"),
    },
    closeBlockers: blockers,
    closedBy: optionalPerson(people, row.closedBy),
    closedAt: iso(row.closedAt),
    closureNote: row.closureNote,
    noActionReason: row.noActionReason,
    voidedBy: optionalPerson(people, row.voidedBy),
    voidedAt: iso(row.voidedAt),
    voidReason: row.voidReason,
    followUpOf: row.followUpOf
      ? { id: row.followUpOf.id, code: recordCode("INC", row.followUpOf.number) }
      : null,
    version: row.version,
    permissions: {
      canEdit: context.canManage && open,
      canInvestigate: context.canManage && open,
      canDecideRegulator: context.canManage && open,
      // A missing verified action can be answered with a reason when closing.
      canClose:
        context.canManage &&
        status === "investigated" &&
        blockers.every((blocker) => blocker === "no_verified_action"),
      canVoid: context.canManage && open,
      canAddPhotos: context.canRecord && open && row.photos.length < 6,
      canRaiseAction: context.canManage && open,
      canSeePeople: context.canSeePersonal,
    },
  });
}

// Corrective actions ----------------------------------------------------------------------------

export const actionInclude = {
  incident: { select: { id: true, number: true, status: true } },
  inspection: { select: { id: true, number: true } },
  toolboxTalk: { select: { id: true, number: true } },
} as const;
export type ActionRow = Prisma.CorrectiveActionGetPayload<{ include: typeof actionInclude }>;
export const actionPeople = (row: ActionRow) => [
  row.ownerId,
  row.doneBy,
  row.verifiedBy,
  row.cancelledBy,
  row.raisedBy,
];

export function toCorrectiveAction(
  row: ActionRow,
  people: People,
  context: SafetyContext,
): CorrectiveAction {
  const today = nairobiDate();
  const facts = { status: row.status as CorrectiveActionStatus, dueOn: toCalendarDate(row.dueOn) };
  const independent = correctiveActionVerifierIndependent(row, context.userId);
  const incidentOpen =
    !row.incident || row.incident.status === "reported" || row.incident.status === "investigated";
  const writable = !context.readOnly && incidentOpen;
  return correctiveActionSchema.parse({
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    code: recordCode("CA", row.number),
    source: row.source,
    incident: row.incident
      ? { id: row.incident.id, code: recordCode("INC", row.incident.number) }
      : null,
    inspection: row.inspection
      ? { id: row.inspection.id, code: recordCode("INS", row.inspection.number) }
      : null,
    toolboxTalk: row.toolboxTalk
      ? { id: row.toolboxTalk.id, code: recordCode("TBT", row.toolboxTalk.number) }
      : null,
    description: row.description,
    owner: personOf(people, row.ownerId),
    dueOn: facts.dueOn,
    overdue: correctiveActionOverdue(facts, today),
    daysOverdue: correctiveActionDaysOverdue(facts, today),
    status: row.status,
    doneBy: optionalPerson(people, row.doneBy),
    doneAt: iso(row.doneAt),
    doneNote: row.doneNote,
    verifiedBy: optionalPerson(people, row.verifiedBy),
    verifiedAt: iso(row.verifiedAt),
    rejectCount: row.rejectCount,
    lastRejectReason: row.lastRejectReason,
    cancelledBy: optionalPerson(people, row.cancelledBy),
    cancelledAt: iso(row.cancelledAt),
    cancelReason: row.cancelReason,
    raisedBy: personOf(people, row.raisedBy),
    raisedAt: row.raisedAt.toISOString(),
    version: row.version,
    permissions: {
      canEdit: writable && context.canManage && row.status === "open",
      canMarkDone: writable && row.status === "open" && row.ownerId === context.userId,
      canVerify: writable && context.canManage && row.status === "done" && independent,
      canReject: writable && context.canManage && row.status === "done" && independent,
      canCancel: writable && context.canManage && (row.status === "open" || row.status === "done"),
    },
  });
}

// First aid -------------------------------------------------------------------------------------

export const kitInclude = {
  site: { select: { name: true } },
  checks: { orderBy: [{ checkedOn: "desc" as const }, { createdAt: "desc" as const }], take: 1 },
  _count: { select: { checks: true } },
} satisfies Prisma.FirstAidKitInclude;
export type KitRow = Prisma.FirstAidKitGetPayload<{ include: typeof kitInclude }>;
export const kitPeople = (row: KitRow) => row.checks.map((check) => check.checkedBy);

export function toKit(
  row: KitRow,
  people: People,
  context: SafetyContext,
  intervalDays: number,
): FirstAidKit {
  const last = row.checks[0] ?? null;
  const lastCheckedOn = last ? toCalendarDate(last.checkedOn) : null;
  const expiresOn = last ? date(last.expiresOn) : null;
  const active = row.status === "active";
  return firstAidKitSchema.parse({
    id: row.id,
    siteId: row.siteId,
    siteName: row.site.name,
    label: row.label,
    location: row.location,
    status: row.status,
    lastCheck: last
      ? {
          checkedOn: lastCheckedOn,
          outcome: last.outcome,
          expiresOn,
          notes: last.notes,
          checkedBy: personOf(people, last.checkedBy),
        }
      : null,
    nextCheckOn: active ? kitNextCheckOn(lastCheckedOn, intervalDays) : null,
    state: kitState(
      { status: row.status as "active" | "retired", lastCheckedOn, expiresOn },
      intervalDays,
      nairobiDate(),
    ),
    checkCount: row._count.checks,
    retiredReason: row.retiredReason,
    version: row.version,
    permissions: {
      canCheck: context.canRecord && active,
      canRetire: context.canManage && active,
    },
  });
}

export const firstAiderInclude = { site: { select: { name: true } } } as const;
export type FirstAiderRow = Prisma.FirstAiderGetPayload<{ include: typeof firstAiderInclude }>;

export function toFirstAider(
  row: FirstAiderRow,
  people: People,
  labourers: Labourers,
  context: SafetyContext,
): FirstAider {
  const expiresOn = toCalendarDate(row.certificateExpiresOn);
  return firstAiderSchema.parse({
    id: row.id,
    siteId: row.siteId,
    siteName: row.site.name,
    labourer: row.labourerId ? labourerOf(labourers, row.labourerId) : null,
    staff: optionalPerson(people, row.userId),
    certificateExpiresOn: expiresOn,
    certificateReference: row.certificateReference,
    certificateState: certificateState(expiresOn, nairobiDate()),
    status: row.status,
    removedReason: row.removedReason,
    version: row.version,
    permissions: { canRemove: context.canManage && row.status === "active" },
  });
}
/** The name shown for a first-aider (a labourer's name or a staff member's display name). */
export const firstAiderName = (row: FirstAiderRow, people: People, labourers: Labourers) =>
  row.labourerId
    ? labourerOf(labourers, row.labourerId).fullName
    : personOf(people, row.userId!).displayName;

export const treatmentInclude = {
  site: { select: { name: true } },
  firstAider: { include: firstAiderInclude },
  incident: { select: { id: true, number: true, status: true } },
} as const;
export type TreatmentRow = Prisma.FirstAidTreatmentGetPayload<{ include: typeof treatmentInclude }>;
export const treatmentPeople = (row: TreatmentRow) => [row.recordedBy, row.firstAider?.userId];
export const treatmentLabourers = (row: TreatmentRow) => [
  row.labourerId,
  row.firstAider?.labourerId,
];

export function toTreatment(
  row: TreatmentRow,
  people: People,
  labourers: Labourers,
  context: SafetyContext,
): Treatment {
  const personal = context.canSeePersonal;
  const recorded = row.status === "recorded";
  const incidentOpen =
    !row.incident || row.incident.status === "reported" || row.incident.status === "investigated";
  return treatmentSchema.parse({
    id: row.id,
    number: row.number,
    code: recordCode("FA", row.number),
    siteId: row.siteId,
    siteName: row.site.name,
    treatedAt: row.treatedAt.toISOString(),
    labourer: personal && row.labourerId ? labourerOf(labourers, row.labourerId) : null,
    personName: personal ? row.personName : null,
    injuryType: personal ? row.injuryType : null,
    treatment: personal ? row.treatment : null,
    restricted: !personal,
    referral: row.referral,
    firstAider: row.firstAider
      ? { id: row.firstAider.id, displayName: firstAiderName(row.firstAider, people, labourers) }
      : null,
    incident: row.incident
      ? { id: row.incident.id, code: recordCode("INC", row.incident.number) }
      : null,
    status: row.status,
    recordedBy: personOf(people, row.recordedBy),
    recordedAt: row.recordedAt.toISOString(),
    voidReason: row.voidReason,
    version: row.version,
    permissions: {
      canVoid: context.canManage && recorded && incidentOpen,
      canLink: context.canManage && recorded && !row.incident,
    },
  });
}
