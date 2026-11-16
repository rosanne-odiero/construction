import { Injectable, NotFoundException } from "@nestjs/common";
import { biometricGate, nairobiDate } from "@pm-buddy/domain";
import {
  BIOMETRIC_CONSENT_KINDS,
  DPIA_REVIEW_INTERVAL_MONTHS,
  type BiometricCaptureMethod,
  type BiometricModality,
  type Permission,
} from "@pm-buddy/types";
import type {
  BiometricSwitchRequest,
  BiometricSwitchResponse,
  BiometricsOverviewResponse,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import {
  approvedDpia,
  companySites,
  latestFor,
  latestSwitches,
  peopleOf,
  siteState,
  summaryOf,
  switchPeople,
} from "./biometrics-store.js";
import { BiometricsPlatform, gateRefusal } from "./biometrics-support.js";

const READERS: readonly Permission[] = ["biometrics.manage", "biometrics.approve"];

/**
 * The biometrics page (D3.4): the DPIA versions, the platform switch and every site's gate state
 * per method, and switching biometric capture on (biometrics.approve with a fresh step-up, only
 * where the gate allows it) or off (biometrics.manage or biometrics.approve, never blocked: off is
 * always safe). Switching is idempotent: asking for the current position records nothing.
 */
@Injectable()
export class BiometricsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly platform: BiometricsPlatform,
  ) {}

  async overview(principal: Principal, req: Request): Promise<BiometricsOverviewResponse> {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.requireAny(scope, READERS);
      const { tx, access } = scope;
      const today = nairobiDate();
      const records = await tx.dpiaRecord.findMany({
        where: { tenantId: access.tenantId },
        orderBy: { versionNo: "desc" },
        select: {
          id: true,
          versionNo: true,
          status: true,
          captureMethods: true,
          reviewDue: true,
          approvedAt: true,
          approvedBy: true,
          createdAt: true,
          createdBy: true,
          _count: { select: { sites: true } },
        },
      });
      const sites = await companySites(tx, access.tenantId);
      const approved = await approvedDpia(tx, access.tenantId);
      const latest = await latestSwitches(tx, access.tenantId);
      const people = await peopleOf(tx, [
        ...records.flatMap((record) => [record.createdBy, record.approvedBy]),
        ...switchPeople(latest),
      ]);
      const summaries = records.map((record) =>
        summaryOf(record, record._count.sites, people, today),
      );
      const platformAvailable = this.platform.isAvailable();
      const { enrolments, consentsThisMonth } = await this.monitoring(scope, today, approved);
      return {
        today,
        platformAvailable,
        reviewIntervalMonths: DPIA_REVIEW_INTERVAL_MONTHS,
        current: summaries.find((summary) => summary.status === "approved") ?? null,
        draft: summaries.find((summary) => summary.status === "draft") ?? null,
        history: summaries,
        sites: sites.map((site) =>
          siteState(site, { platformAvailable, approved, latest, today, people }),
        ),
        enrolments,
        consentsThisMonth,
        retention: {
          daysAfterEngagement: this.platform.retentionDays,
          jobEnabled: this.platform.retentionJobEnabled,
        },
        templateKeyConfigured: this.platform.sealer !== null,
        permissions: {
          canPrepare: access.permissions.has("biometrics.manage"),
          canApprove: access.permissions.has("biometrics.approve"),
          canSwitchOn: access.permissions.has("biometrics.approve"),
          canSwitchOff: READERS.some((permission) => access.permissions.has(permission)),
          canManageTemplates: access.permissions.has("biometrics.manage"),
        },
      };
    });
  }

  /**
   * Active enrolments per modality (held while the DPIA has lapsed; due once their retention date
   * has come) and this month's consent decisions per modality, for the DPO's monitoring of refusal
   * and withdrawal rates (DPIA §7.1). Counts only.
   */
  private async monitoring(
    scope: Scope,
    today: string,
    approved: Awaited<ReturnType<typeof approvedDpia>>,
  ) {
    const { tx, access } = scope;
    const active = await tx.$queryRaw<{ modality: string; total: bigint; due: bigint }[]>`
      SELECT e.modality, count(*) AS total,
             count(*) FILTER (WHERE app.biometric_retention_due_on(e.tenant_id, e.labourer_id,
               ${this.platform.retentionDays}::integer) <= ${today}::date) AS due
        FROM biometric_enrolments e
       WHERE e.tenant_id = ${access.tenantId}::uuid AND e.status = 'active'
       GROUP BY e.modality`;
    const decisions = await tx.$queryRaw<
      { kind: string; granted: bigint; refused: bigint; withdrawn: bigint }[]
    >`
      WITH month AS (
        SELECT (date_trunc('month', now() AT TIME ZONE 'Africa/Nairobi')
                AT TIME ZONE 'Africa/Nairobi') AS starts)
      SELECT c.kind,
             count(*) FILTER (WHERE c.granted AND c.captured_at >= month.starts) AS granted,
             count(*) FILTER (WHERE NOT c.granted AND c.captured_at >= month.starts) AS refused,
             count(*) FILTER (WHERE c.withdrawn_at >= month.starts) AS withdrawn
        FROM labourer_consents c, month
       WHERE c.tenant_id = ${access.tenantId}::uuid
         AND c.kind IN ('biometric_face', 'biometric_fingerprint')
         AND (c.captured_at >= month.starts OR c.withdrawn_at >= month.starts)
       GROUP BY c.kind`;
    const count = (modality: BiometricModality, field: "total" | "due") =>
      Number(active.find((row) => row.modality === modality)?.[field] ?? 0n);
    const total = count("face", "total") + count("fingerprint", "total");
    const due = count("face", "due") + count("fingerprint", "due");
    const decided = (modality: BiometricModality) => {
      const row = decisions.find((entry) => entry.kind === BIOMETRIC_CONSENT_KINDS[modality]);
      return {
        granted: Number(row?.granted ?? 0n),
        refused: Number(row?.refused ?? 0n),
        withdrawn: Number(row?.withdrawn ?? 0n),
      };
    };
    const inForce = approved !== null && approved.reviewDue >= today;
    return {
      enrolments: {
        face: count("face", "total"),
        fingerprint: count("fingerprint", "total"),
        held: inForce ? 0 : total - due,
        deletionDue: due,
      },
      consentsThisMonth: {
        month: today.slice(0, 7),
        face: decided("face"),
        fingerprint: decided("fingerprint"),
      },
    };
  }

  async setSwitch(
    principal: Principal,
    siteId: string,
    method: BiometricCaptureMethod,
    input: BiometricSwitchRequest,
    req: Request,
  ): Promise<BiometricSwitchResponse> {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        if (input.enabled) await this.policy.require(scope, "biometrics.approve", { stepUp: true });
        else await this.policy.requireAny(scope, READERS);
        const { tx, access } = scope;
        const site = (await companySites(tx, access.tenantId)).find(
          (candidate) => candidate.id === siteId,
        );
        if (!site) throw new NotFoundException("Site not found");
        const today = nairobiDate();
        const approved = await approvedDpia(tx, access.tenantId);
        let latest = await latestSwitches(tx, access.tenantId, siteId);
        const current = latestFor(latest, siteId, method);
        if (input.enabled) {
          const gate = biometricGate({
            platformAvailable: this.platform.isAvailable(),
            projectStatus: site.projectStatus,
            approved,
            latestSwitch: current,
            siteId,
            method,
            today,
          });
          if (!gate.on && gate.reason !== "switched_off") throw gateRefusal(gate.reason);
          if (!gate.on) {
            await tx.biometricSwitch.create({
              data: {
                tenantId: access.tenantId,
                projectId: site.projectId,
                siteId,
                method,
                enabled: true,
                dpiaRecordId: approved!.id,
                reason: input.reason ?? null,
                actorId: access.userId,
              },
            });
            const versionNo = (
              await tx.dpiaRecord.findUniqueOrThrow({
                where: { tenantId_id: { tenantId: access.tenantId, id: approved!.id } },
                select: { versionNo: true },
              })
            ).versionNo;
            await this.scope.audit(tx, "biometrics.switched_on", siteId, {
              projectId: site.projectId,
              method,
              dpiaVersionNo: versionNo,
            });
            latest = await latestSwitches(tx, access.tenantId, siteId);
          }
        } else if (current?.enabled) {
          await tx.biometricSwitch.create({
            data: {
              tenantId: access.tenantId,
              projectId: site.projectId,
              siteId,
              method,
              enabled: false,
              dpiaRecordId: current.dpiaRecordId,
              reason: input.reason ?? null,
              actorId: access.userId,
            },
          });
          await this.scope.audit(tx, "biometrics.switched_off", siteId, {
            projectId: site.projectId,
            method,
          });
          latest = await latestSwitches(tx, access.tenantId, siteId);
        }
        const people = await peopleOf(tx, switchPeople(latest));
        return {
          site: siteState(site, {
            platformAvailable: this.platform.isAvailable(),
            approved,
            latest,
            today,
            people,
          }),
        };
      },
      true,
    );
  }
}
