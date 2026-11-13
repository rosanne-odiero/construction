import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import type { InboxKind, Permission } from "@pm-buddy/types";
import {
  commitmentsResponseSchema,
  inboxResponseSchema,
  type InboxItem,
} from "@pm-buddy/validation";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { supplierRef } from "../procurement-mappers.js";
import { iso, P2pAccess, projectRef, type ProjectAccess } from "./p2p-common.js";

const ACCRUED = ["approved", "partly_settled", "settled"];

/**
 * The "waiting for me" inbox and the commitments view (D5.2). The inbox lists only what the caller
 * may act on now: they hold the permission on the project and did not contribute to the record
 * (maker-checker), and a blocked invoice only when its mismatch may be excepted. Commitments (brief §5.8, §15 C) keep committed (approved LPOs), accrued
 * (approved invoices) and paid (settlements) apart, per project and BQ item, net of VAT except
 * paid amounts (cash, gross); D5.4 budgets read them from here.
 */
@Injectable()
export class P2pOverviewService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: P2pAccess,
  ) {}

  inbox(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const projectIds = await this.access.visibleProjectIds(scope);
      const cache = new Map<string, ProjectAccess>();
      const on = async (projectId: string) => {
        if (!cache.has(projectId)) cache.set(projectId, await this.access.on(scope, projectId));
        return cache.get(projectId)!;
      };
      const holds = async (projectId: string, permission: Permission) =>
        (await on(projectId)).permissions.has(permission);
      const items: InboxItem[] = [];
      const push = async (
        kind: InboxKind,
        row: { id: string; projectId: string; contributors?: string[] },
        label: string,
        since: Date,
        href: string,
        amountMinor: number | null = null,
        supplier: {
          id: string;
          code: string;
          legalName: string;
          tradingName: string | null;
        } | null = null,
      ) => {
        const project = await on(row.projectId);
        items.push({
          kind,
          id: row.id,
          label,
          project: projectRef(project.project),
          supplier: supplier ? supplierRef(supplier) : null,
          amountMinor,
          since: iso(since),
          href,
        });
      };
      const mine = (contributors: string[]) => contributors.includes(access.userId);

      const requisitions = await tx.requisition.findMany({
        where: { tenantId: access.tenantId, projectId: { in: projectIds }, status: "submitted" },
        orderBy: { submittedAt: "asc" },
      });
      for (const row of requisitions)
        if ((await holds(row.projectId, "procurement.approve")) && !mine(row.contributors))
          await push(
            "requisition-approval",
            row,
            row.number,
            row.submittedAt!,
            `/procurement/requisitions/${row.id}`,
          );

      const rfqs = await tx.rfq.findMany({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          status: "open",
          exceptionRequestedAt: { not: null },
          exceptionApprovedAt: null,
        },
      });
      for (const row of rfqs)
        if ((await holds(row.projectId, "procurement.approve")) && !mine(row.contributors))
          await push(
            "rfq-exception",
            row,
            row.number,
            row.exceptionRequestedAt!,
            `/procurement/rfqs/${row.id}`,
          );

      const lpos = await tx.lpo.findMany({
        where: { tenantId: access.tenantId, projectId: { in: projectIds }, status: "submitted" },
        include: { supplier: true },
        orderBy: { submittedAt: "asc" },
      });
      for (const row of lpos)
        if ((await holds(row.projectId, "procurement.approve")) && !mine(row.contributors))
          await push(
            "lpo-approval",
            row,
            row.number,
            row.submittedAt!,
            `/procurement/lpos/${row.id}`,
            Number(row.totalMinor),
            row.supplier,
          );

      const invoices = await tx.supplierInvoice.findMany({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          status: { in: ["disputed", "matched", "approved", "partly_settled"] },
        },
        include: {
          supplier: true,
          payables: {
            include: {
              payoutVersion: { select: { status: true } },
              settlements: { select: { amountMinor: true } },
            },
          },
          matches: {
            orderBy: [{ computedAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { evidence: true, exceptionAt: true },
          },
        },
        orderBy: { updatedAt: "asc" },
      });
      for (const row of invoices) {
        const href = `/procurement/invoices/${row.id}`;
        const label = `${row.invoiceNumber}`;
        const approver =
          (await holds(row.projectId, "payments.approve")) && !mine(row.contributors);
        const active = row.payables.find((payable) => !payable.supersededAt);
        const current = active && active.payoutVersion.status === "verified";
        // Only a mismatch an exception may override is waiting for an approver (never a missing
        // eTIMS number, inconsistent totals or a line that is not on the LPO).
        const latest = row.matches[0];
        const exceptable =
          latest !== undefined &&
          latest.exceptionAt === null &&
          (latest.evidence as { exceptable?: boolean } | null)?.exceptable === true;
        if (row.status === "disputed" && approver && exceptable)
          await push(
            "invoice-exception",
            row,
            label,
            row.updatedAt,
            href,
            Number(row.totalMinor),
            row.supplier,
          );
        if (row.status === "matched" && approver)
          await push(
            "invoice-approval",
            row,
            label,
            row.updatedAt,
            href,
            Number(row.totalMinor),
            row.supplier,
          );
        if (["approved", "partly_settled"].includes(row.status)) {
          const settled = row.payables
            .flatMap((payable) => payable.settlements)
            .reduce((sum, entry) => sum + Number(entry.amountMinor), 0);
          const outstanding = Number(row.totalMinor) - settled;
          if (!current && approver)
            await push(
              "invoice-reapproval",
              row,
              label,
              row.updatedAt,
              href,
              outstanding,
              row.supplier,
            );
          if (
            current &&
            active?.approvedBy !== access.userId &&
            (await holds(row.projectId, "payments.disburse"))
          )
            await push(
              "invoice-settlement",
              row,
              label,
              row.updatedAt,
              href,
              outstanding,
              row.supplier,
            );
        }
      }
      return inboxResponseSchema.parse({ items });
    });
  }

  commitments(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope: Scope) => {
      const { tx, access } = scope;
      const project = await this.access.viewer(scope, projectId);
      const [lpoLines, invoiceLines, settlements] = await Promise.all([
        tx.lpoLine.findMany({
          where: { tenantId: access.tenantId, lpo: { projectId, status: "approved" } },
          include: {
            requisitionLine: { include: { bqItem: { select: { ref: true, description: true } } } },
          },
        }),
        tx.supplierInvoiceLine.findMany({
          where: { tenantId: access.tenantId, invoice: { projectId, status: { in: ACCRUED } } },
          include: {
            lpoLine: {
              include: {
                requisitionLine: {
                  include: { bqItem: { select: { ref: true, description: true } } },
                },
              },
            },
          },
        }),
        tx.invoiceSettlement.aggregate({
          where: { tenantId: access.tenantId, payable: { invoice: { projectId } } },
          _sum: { amountMinor: true },
        }),
      ]);
      type Bucket = {
        bqItem: {
          versionId: string;
          lineageId: string;
          ref: string | null;
          description: string;
        } | null;
        committed: number;
        accrued: number;
      };
      const buckets = new Map<string, Bucket>();
      const bucket = (line: {
        bqVersionId: string | null;
        bqItemLineageId: string | null;
        bqItem: { ref: string | null; description: string } | null;
      }) => {
        const key =
          line.bqVersionId && line.bqItemLineageId ? `${line.bqItemLineageId}` : "untagged";
        if (!buckets.has(key))
          buckets.set(key, {
            bqItem:
              line.bqVersionId && line.bqItemLineageId && line.bqItem
                ? {
                    versionId: line.bqVersionId,
                    lineageId: line.bqItemLineageId,
                    ref: line.bqItem.ref,
                    description: line.bqItem.description,
                  }
                : null,
            committed: 0,
            accrued: 0,
          });
        return buckets.get(key)!;
      };
      for (const line of lpoLines)
        bucket(line.requisitionLine).committed += Number(line.netAmountMinor);
      for (const line of invoiceLines)
        bucket(line.lpoLine.requisitionLine).accrued += Number(line.netAmountMinor);
      const items = [...buckets.values()].map((entry) => ({
        bqItem: entry.bqItem,
        committedMinor: entry.committed,
        accruedMinor: entry.accrued,
        openCommitmentMinor: Math.max(0, entry.committed - entry.accrued),
      }));
      const sum = (pick: (item: (typeof items)[number]) => number) =>
        items.reduce((total, item) => total + pick(item), 0);
      return commitmentsResponseSchema.parse({
        project: projectRef(project.project),
        totals: {
          committedMinor: sum((item) => item.committedMinor),
          accruedMinor: sum((item) => item.accruedMinor),
          openCommitmentMinor: sum((item) => item.openCommitmentMinor),
          paidMinor: Number(settlements._sum.amountMinor ?? 0n),
        },
        items,
      });
    });
  }
}
