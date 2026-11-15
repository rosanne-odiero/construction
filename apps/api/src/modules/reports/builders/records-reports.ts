import {
  addCalendarDays,
  calendarDaysBetween,
  safeAuditMetadata,
  valuationCode,
  zonedDateTime,
} from "@pm-buddy/domain";
import type {
  CorrectiveActionStatus,
  IncidentKind,
  IncidentSeverity,
  IncidentStatus,
  ReleaseStage,
  ValuationStatus,
} from "@pm-buddy/types";
import type { ReportCell } from "@pm-buddy/validation";
import {
  bounded,
  column,
  displayNames,
  money,
  sum,
  type BuildContext,
  type BuildResult,
} from "../report-model.js";

/**
 * Valuations and certificates (D6.3): every valuation of the project with its frozen figures
 * (null while a draft); totals add certified certificates only. Same permission as the valuation
 * screens: bq.edit, finance.view or finance.manage on the project.
 */
export async function valuationsRegister(ctx: BuildContext): Promise<BuildResult> {
  const { tx, access } = ctx.scope;
  const t = ctx.t.valuations;
  const valuations = bounded(
    await tx.valuation.findMany({
      where: { tenantId: access.tenantId, projectId: ctx.params.projectId! },
      select: {
        number: true,
        certificateNumber: true,
        kind: true,
        releaseStage: true,
        status: true,
        valuationDate: true,
        grossMinor: true,
        retentionHeldMinor: true,
        previousCertifiedMinor: true,
        amountDueMinor: true,
        vatMinor: true,
        totalMinor: true,
        certifiedAt: true,
      },
      orderBy: { number: "asc" },
      take: ctx.maxRows + 1,
    }),
    ctx.maxRows,
  );
  const kinds = ctx.m.valuations.kinds;
  const rows: ReportCell[][] = valuations.map((valuation) => [
    valuationCode("VAL", valuation.number),
    valuation.certificateNumber === null ? null : valuationCode("IPC", valuation.certificateNumber),
    valuation.kind === "interim"
      ? kinds.interim
      : kinds.release[(valuation.releaseStage ?? "practical") as ReleaseStage],
    valuation.valuationDate.toISOString().slice(0, 10),
    ctx.m.valuations.status[valuation.status as ValuationStatus],
    money(valuation.grossMinor),
    money(valuation.retentionHeldMinor),
    money(valuation.previousCertifiedMinor),
    money(valuation.amountDueMinor),
    money(valuation.vatMinor),
    money(valuation.totalMinor),
    valuation.certifiedAt ? valuation.certifiedAt.toISOString() : null,
  ]);
  const certified = rows.filter((_, index) => valuations[index]!.status === "certified");
  return {
    sections: [
      {
        key: "certificates",
        title: t.section,
        columns: [
          column("valuation", t.valuation, "text"),
          column("certificate", t.certificate, "text"),
          column("kind", t.kind, "text"),
          column("date", t.date, "date"),
          column("status", t.status, "text"),
          column("gross", t.gross, "money"),
          column("retention", t.retention, "money"),
          column("previous", t.previous, "money"),
          column("due", t.due, "money"),
          column("vat", t.vat, "money"),
          column("total", t.total, "money"),
          column("certifiedOn", t.certifiedOn, "datetime"),
        ],
        rows,
        totals: rows.length
          ? [
              ctx.t.total,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              sum(certified, 8),
              sum(certified, 9),
              sum(certified, 10),
              null,
            ]
          : null,
        notes: [t.note],
      },
    ],
    notes: [],
  };
}

/**
 * Health and safety (D8.2): incidents that occurred in the period and corrective actions raised in
 * it or still open, overdue first. No description, people or injury fields are read, so nothing
 * restricted to safety.manage can appear. Same permission as the project's safety tab
 * (projects.view and SAFETY_READ_PERMISSIONS).
 */
export async function safetyActions(ctx: BuildContext): Promise<BuildResult> {
  const { tx, access } = ctx.scope;
  const t = ctx.t.safety;
  const { from, to } = ctx.params.period!;
  const projectId = ctx.params.projectId!;
  const start = zonedDateTime(from, 0);
  const end = zonedDateTime(addCalendarDays(to, 1), 0);
  const [incidents, actions, sites] = await Promise.all([
    tx.safetyIncident.findMany({
      where: { tenantId: access.tenantId, projectId, occurredAt: { gte: start, lt: end } },
      select: {
        number: true,
        occurredAt: true,
        siteId: true,
        kind: true,
        severity: true,
        status: true,
        correctiveActions: { select: { status: true } },
      },
      orderBy: [{ occurredAt: "asc" }, { number: "asc" }],
      take: ctx.maxRows + 1,
    }),
    tx.correctiveAction.findMany({
      where: {
        tenantId: access.tenantId,
        projectId,
        OR: [{ raisedAt: { gte: start, lt: end } }, { status: { in: ["open", "done"] } }],
      },
      select: {
        number: true,
        source: true,
        incident: { select: { number: true } },
        ownerId: true,
        dueOn: true,
        status: true,
        doneAt: true,
        verifiedAt: true,
      },
      orderBy: [{ dueOn: "asc" }, { number: "asc" }],
      take: ctx.maxRows + 1,
    }),
    tx.site.findMany({
      where: { tenantId: access.tenantId, projectId },
      select: { id: true, name: true },
    }),
  ]);
  bounded(incidents, ctx.maxRows);
  bounded(actions, ctx.maxRows);
  const siteName = new Map(sites.map((site) => [site.id, site.name]));
  const owners = await displayNames(
    tx,
    actions.map((action) => action.ownerId),
  );
  const code = (prefix: string, number: number) => `${prefix}-${String(number).padStart(4, "0")}`;
  const incidentRows: ReportCell[][] = incidents.map((incident) => [
    code("INC", incident.number),
    incident.occurredAt.toISOString(),
    siteName.get(incident.siteId) ?? "",
    ctx.m.safety.kind[incident.kind as IncidentKind],
    ctx.m.safety.severity[incident.severity as IncidentSeverity],
    ctx.m.safety.incidentStatus[incident.status as IncidentStatus],
    String(incident.correctiveActions.length),
    String(incident.correctiveActions.filter((action) => action.status === "open").length),
  ]);
  const overdueDays = (action: (typeof actions)[number]) =>
    action.status === "open"
      ? Math.max(0, calendarDaysBetween(action.dueOn.toISOString().slice(0, 10), ctx.today))
      : 0;
  const sorted = [...actions].sort(
    (a, b) => Number(overdueDays(b) > 0) - Number(overdueDays(a) > 0),
  );
  const sources = ctx.m.safety.actionSource as Record<string, string>;
  const actionRows: ReportCell[][] = sorted.map((action) => [
    code("CA", action.number),
    sources[action.source] ?? action.source,
    action.incident ? code("INC", action.incident.number) : null,
    owners.get(action.ownerId) ?? "—",
    action.dueOn.toISOString().slice(0, 10),
    ctx.m.safety.actionStatus[action.status as CorrectiveActionStatus],
    String(overdueDays(action)),
    action.doneAt ? action.doneAt.toISOString() : null,
    action.verifiedAt ? action.verifiedAt.toISOString() : null,
  ]);
  return {
    sections: [
      {
        key: "incidents",
        title: t.incidents,
        columns: [
          column("number", t.number, "text"),
          column("occurred", t.occurred, "datetime"),
          column("site", t.site, "text"),
          column("kind", t.kind, "text"),
          column("severity", t.severity, "text"),
          column("status", t.status, "text"),
          column("actions", t.actionCount, "quantity"),
          column("openActions", t.openActions, "quantity"),
        ],
        rows: incidentRows,
        totals: null,
        notes: [],
      },
      {
        key: "actions",
        title: t.actions,
        columns: [
          column("number", t.number, "text"),
          column("source", t.source, "text"),
          column("incident", t.incident, "text"),
          column("owner", t.owner, "text"),
          column("due", t.due, "date"),
          column("status", t.status, "text"),
          column("overdue", t.overdue, "quantity"),
          column("done", t.done, "datetime"),
          column("verified", t.verified, "datetime"),
        ],
        rows: actionRows,
        totals: null,
        notes: [],
      },
    ],
    notes: [t.note],
  };
}

/**
 * Audit log (company): events of the period, newest first, optionally one person's and/or actions
 * starting with a prefix. Details are reduced to IDs, codes and numbers (packages/domain
 * safeAuditMetadata). Same permission as the audit screen: audit.view with a recent MFA check.
 */
export async function auditLog(ctx: BuildContext): Promise<BuildResult> {
  const { tx, access } = ctx.scope;
  const t = ctx.t.audit;
  const { from, to } = ctx.params.period!;
  const events = bounded(
    await tx.auditEvent.findMany({
      where: {
        tenantId: access.tenantId,
        createdAt: { gte: zonedDateTime(from, 0), lt: zonedDateTime(addCalendarDays(to, 1), 0) },
        ...(ctx.params.actorId ? { actorId: ctx.params.actorId } : {}),
        ...(ctx.params.action ? { action: { startsWith: ctx.params.action } } : {}),
      },
      select: {
        sequence: true,
        createdAt: true,
        actorId: true,
        action: true,
        resourceId: true,
        metadata: true,
      },
      orderBy: { sequence: "desc" },
      take: ctx.maxRows + 1,
    }),
    ctx.maxRows,
  );
  const people = await displayNames(
    tx,
    events.map((event) => event.actorId),
  );
  const safeId = (value: string) =>
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(value) ? value : "[text]";
  const rows: ReportCell[][] = events.map((event) => [
    event.sequence.toString(),
    event.createdAt.toISOString(),
    people.get(event.actorId) ?? "—",
    event.action,
    safeId(event.resourceId),
    safeAuditMetadata(event.metadata),
  ]);
  return {
    sections: [
      {
        key: "events",
        title: t.section,
        columns: [
          column("sequence", t.sequence, "text"),
          column("time", t.time, "datetime"),
          column("actor", t.actor, "text"),
          column("action", t.action, "text"),
          column("resource", t.resource, "text"),
          column("metadata", t.metadata, "text"),
        ],
        rows,
        totals: null,
        notes: [t.note],
      },
    ],
    notes: [],
  };
}
