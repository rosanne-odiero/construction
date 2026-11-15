import { Injectable } from "@nestjs/common";
import {
  approvalDaysOverdue,
  approvalRequestCode,
  compareReminders,
  complianceCounts,
  complianceToday,
  isProjectReadOnly,
} from "@pm-buddy/domain";
import { COMPLIANCE_LIMITS, type ProjectStatus } from "@pm-buddy/types";
import {
  documentsOverviewResponseSchema,
  projectDocumentsSummaryResponseSchema,
  type DocumentReminder,
  type ProjectDocumentsSummary,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import { ComplianceService } from "./compliance.service.js";
import {
  DocumentsAccess,
  type DocumentsCaller,
  type DocumentsProject,
} from "./documents-access.js";

const reminderOrder = (a: DocumentReminder, b: DocumentReminder) =>
  compareReminders(
    {
      kind: a.kind,
      daysLeft: a.daysLeft,
      label: `${a.project?.code ?? ""}${a.type?.key ?? a.approval?.code ?? ""}`,
    },
    {
      kind: b.kind,
      daysLeft: b.daysLeft,
      label: `${b.project?.code ?? ""}${b.type?.key ?? b.approval?.code ?? ""}`,
    },
  );

/**
 * Reminders computed on read (D8.4, decision D-116): each project's documents, compliance,
 * instructions and approvals in one summary (the project overview and the Documents tab), and the
 * company-wide "expiring soon" list across every project the caller can read. Delivery by email,
 * SMS or WhatsApp is the D7.3 notification centre's job; nothing is sent from here.
 */
@Injectable()
export class DocumentsOverviewService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: DocumentsAccess,
    private readonly compliance: ComplianceService,
  ) {}

  private async summaries(scope: Scope, caller: DocumentsCaller, projects: DocumentsProject[]) {
    const { tx, access } = scope;
    const ids = projects.map((project) => project.id);
    const today = complianceToday();
    const [facts, documents, instructions, flagged, approvals] = await Promise.all([
      this.compliance.facts(scope, ids),
      tx.document.groupBy({
        by: ["projectId", "category"],
        where: { tenantId: access.tenantId, projectId: { in: ids }, status: "active" },
        _count: { _all: true },
      }),
      tx.instruction.groupBy({
        by: ["projectId"],
        where: { tenantId: access.tenantId, projectId: { in: ids }, status: { not: "closed" } },
        _count: { _all: true },
      }),
      tx.instruction.groupBy({
        by: ["projectId"],
        where: {
          tenantId: access.tenantId,
          projectId: { in: ids },
          status: { not: "closed" },
          OR: [{ costImplication: true }, { timeImplication: true }],
        },
        _count: { _all: true },
      }),
      tx.approvalRequest.findMany({
        where: { tenantId: access.tenantId, projectId: { in: ids }, status: "pending" },
        select: { id: true, projectId: true, number: true, title: true, dueOn: true },
      }),
    ]);
    const result = new Map<string, ProjectDocumentsSummary>();
    for (const project of projects) {
      const items = this.compliance.items(facts, caller, project.id);
      const visible = documents.filter(
        (group) =>
          group.projectId === project.id &&
          caller.canSeeCategory(project.id, group.category as never),
      );
      const pending = approvals.filter((row) => row.projectId === project.id);
      const ref = { id: project.id, code: project.code, name: project.name };
      const overdue: DocumentReminder[] = pending
        .filter((row) => toCalendarDate(row.dueOn) < today)
        .map((row) => ({
          kind: "approval_overdue",
          project: ref,
          type: null,
          approval: { id: row.id, code: approvalRequestCode(row.number), title: row.title },
          expiresOn: null,
          dueOn: toCalendarDate(row.dueOn),
          daysLeft: -approvalDaysOverdue("pending", toCalendarDate(row.dueOn), today),
        }));
      result.set(project.id, {
        documents: {
          active: visible.reduce((sum, group) => sum + group._count._all, 0),
          drawings: visible
            .filter((group) => group.category === "drawing")
            .reduce((sum, group) => sum + group._count._all, 0),
        },
        compliance: complianceCounts(items.map((item) => item.status)),
        reminders: [...ComplianceService.reminders(items, ref), ...overdue].sort(reminderOrder),
        instructions: {
          open: instructions.find((group) => group.projectId === project.id)?._count._all ?? 0,
          costOrTime: flagged.find((group) => group.projectId === project.id)?._count._all ?? 0,
        },
        approvals: { pending: pending.length, overdue: overdue.length },
      });
    }
    return { facts, result, today };
  }

  summary(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.reader(scope, projectId);
      const project = caller.projects.get(projectId)!;
      const { result } = await this.summaries(scope, caller, [project]);
      return projectDocumentsSummaryResponseSchema.parse({ summary: result.get(projectId)! });
    });
  }

  overview(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.anyReader(scope);
      const projects = caller.readableProjects();
      const { facts, result, today } = await this.summaries(scope, caller, projects);
      const companyItems = this.compliance.items(facts, caller, null);
      // Closed and cancelled projects keep their registers but raise no reminders.
      const reminders = [
        ...ComplianceService.reminders(companyItems, null),
        ...projects
          .filter((project) => !isProjectReadOnly(project.status as ProjectStatus))
          .flatMap((project) =>
            result.get(project.id)!.reminders.filter((reminder) => reminder.project !== null),
          ),
      ]
        .sort(reminderOrder)
        .slice(0, COMPLIANCE_LIMITS.maxReminders);
      return documentsOverviewResponseSchema.parse({
        today,
        projects: projects.map((project) => ({
          id: project.id,
          code: project.code,
          name: project.name,
          status: project.status,
          summary: result.get(project.id)!,
        })),
        companyItems,
        reminders,
        permissions: {
          canRecordCompany: caller.canConfigure,
          canConfigure: caller.canConfigure,
        },
      });
    });
  }
}
