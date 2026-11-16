import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { nairobiDate } from "@pm-buddy/domain";
import { BIOMETRIC_JOB, BIOMETRICS_SYSTEM_ACTOR } from "@pm-buddy/types";
import type { BiometricRetentionRunResponse } from "@pm-buddy/validation";
import type { Request } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infra/prisma.service.js";
import { AccessPolicy } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantDatabase } from "../identity/tenant-database.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { toCalendarDate } from "./biometrics-store.js";
import { BiometricsPlatform } from "./biometrics-support.js";
import { deleteEnrolment } from "./enrolment-deletion.js";

/** pg advisory lock key for the retention job (any fixed 64-bit number; "pmb-bior"). */
const LOCK_KEY = 0x706d622d62696f72n;
const REQUEST_ID = "biometric-retention";

/**
 * Template retention (D3.4; DPIA_TEMPLATE §8, decision D-169). Templates are deleted
 * BIOMETRICS_RETENTION_DAYS_AFTER_ENGAGEMENT full days after the last day of the worker's last
 * engagement in the company, once none is open (app.biometric_retention_due_on). When
 * BIOMETRICS_RETENTION_JOB is on, one instance — the one holding a Postgres advisory lock — looks
 * every hour (and a minute after start) for companies holding active enrolments
 * (app.biometric_retention_tenants, IDs only) and deletes what is due in each company's own
 * transaction, as the job's system actor; a `biometrics.manage` holder can run it for their
 * company at once. Every deletion leaves a deletion log row (written by the database) and an
 * audit event. The database refuses to delete an engaged worker's templates for retention.
 */
@Injectable()
export class BiometricRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BiometricRetentionService.name);
  private first: NodeJS.Timeout | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: TenantDatabase,
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly platform: BiometricsPlatform,
  ) {}

  onModuleInit() {
    if (!this.platform.retentionJobEnabled) return;
    this.first = setTimeout(() => void this.tick(), BIOMETRIC_JOB.firstRunDelaySeconds * 1000);
    this.first.unref();
    this.timer = setInterval(() => void this.tick(), BIOMETRIC_JOB.intervalMinutes * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.runDue();
      if (result?.deleted)
        this.logger.log(`Biometric retention: ${result.deleted} enrolments' templates deleted`);
    } catch (error) {
      this.logger.warn(`Biometric retention cycle failed: ${(error as Error).name}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One cycle across companies; null when another instance holds the lock. A company's failure is
   * logged (without content) and never stops the others.
   */
  async runDue(): Promise<BiometricRetentionRunResponse | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${LOCK_KEY}::bigint) AS locked`;
        if (!lock?.locked) return null;
        const tenants = await tx.$queryRaw<{ tenant_id: string }[]>`
          SELECT tenant_id FROM app.biometric_retention_tenants()`;
        let deleted = 0;
        for (const { tenant_id: tenantId } of tenants) {
          try {
            deleted += await this.db.run(
              { userId: BIOMETRICS_SYSTEM_ACTOR, tenantId, requestId: REQUEST_ID },
              (inner) => this.sweep(inner, tenantId),
              60_000,
            );
          } catch (error) {
            this.logger.warn(
              `Biometric retention failed for one company: ${(error as Error).name}`,
            );
          }
        }
        return { deleted };
      },
      { timeout: 600_000, maxWait: 10_000 },
    );
  }

  /** An administrator's "run now" for their own company (biometrics.manage). */
  runForCompany(principal: Principal, req: Request): Promise<BiometricRetentionRunResponse> {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.require(scope, "biometrics.manage");
        return { deleted: await this.sweep(scope.tx, scope.access.tenantId) };
      },
      true,
      60_000,
    );
  }

  /** Deletes the company's due enrolments, in its row-level-security context. */
  private async sweep(tx: Prisma.TransactionClient, tenantId: string): Promise<number> {
    const due = await tx.$queryRaw<{ id: string; modality: string; due_on: Date }[]>`
      SELECT e.id, e.modality, d.due_on
        FROM biometric_enrolments e
       CROSS JOIN LATERAL (SELECT app.biometric_retention_due_on(e.tenant_id, e.labourer_id,
         ${this.platform.retentionDays}::integer) AS due_on) d
       WHERE e.tenant_id = ${tenantId}::uuid AND e.status = 'active'
         AND d.due_on <= ${nairobiDate()}::date
       ORDER BY e.id
       LIMIT ${BIOMETRIC_JOB.batch}`;
    let deleted = 0;
    for (const row of due) {
      const dueOn = toCalendarDate(row.due_on);
      const templates = await deleteEnrolment(
        tx,
        this.scope,
        tenantId,
        row.id,
        "engagement_ended",
        dueOn,
      );
      if (templates === null) continue;
      deleted += 1;
      await this.scope.audit(tx, "biometrics.enrolment_deleted", row.id, {
        modality: row.modality,
        reason: "engagement_ended",
        templates,
        dueOn,
      });
    }
    return deleted;
  }
}
