import { Injectable, NotFoundException } from "@nestjs/common";
import { biometricGate, nairobiDate } from "@pm-buddy/domain";
import {
  DPIA_REVIEW_INTERVAL_MONTHS,
  type BiometricCaptureMethod,
  type Permission,
} from "@pm-buddy/types";
import type {
  BiometricSwitchRequest,
  BiometricSwitchResponse,
  BiometricsOverviewResponse,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { AccessPolicy } from "../identity/access-policy.js";
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
        permissions: {
          canPrepare: access.permissions.has("biometrics.manage"),
          canApprove: access.permissions.has("biometrics.approve"),
          canSwitchOn: access.permissions.has("biometrics.approve"),
          canSwitchOff: READERS.some((permission) => access.permissions.has(permission)),
        },
      };
    });
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
