import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import { describeError } from "../../common/errors.js";
import { AppConfig } from "../../config/app-config.js";
import { PrismaService } from "../../infra/prisma.service.js";
import { PaymentProcessor } from "./payment-processor.js";
import { PaymentsRuntime } from "./payments-runtime.js";
import { PAYMENTS_SYSTEM_ACTOR } from "./payments-support.js";
import { TenantDatabase } from "../identity/tenant-database.service.js";

type Due = { tenant_id: string; work: "outbox" | "watchdog"; ref_id: string };
type JobData = { tenantId: string; work: "outbox" | "watchdog"; refId: string };

/**
 * The transactional outbox relay and BullMQ workers (ARCHITECTURE §4.5). Every few seconds the
 * relay asks the database (a definer function returning identifiers only) for due outbox rows and
 * stuck attempts, enqueues each as a BullMQ job whose ID is derived from the row (so a repeated
 * dispatch is ignored), and marks the row dispatched. When Valkey is unavailable the same items are
 * processed directly ("drain"), so callbacks persisted during a queue outage are still processed.
 * Retries are the outbox's own bounded backoff; BullMQ never retries a job by itself.
 */
@Injectable()
export class PaymentsRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsRelay.name);
  private queue: Queue<JobData> | null = null;
  private worker: Worker<JobData> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private relaying = false;
  private queueDownLoggedAt = 0;
  private readonly queueName: string;

  constructor(
    private readonly runtime: PaymentsRuntime,
    private readonly processor: PaymentProcessor,
    private readonly prisma: PrismaService,
    private readonly db: TenantDatabase,
    private readonly config: AppConfig,
  ) {
    // One queue per database, so a development API and the e2e suite never take each other's jobs.
    const database = new URL(config.get("DATABASE_URL")).pathname.replace(/\W/g, "") || "pmb";
    this.queueName = `pmb-payments-${database}`;
  }

  onApplicationBootstrap() {
    if (this.runtime.workersEnabled) this.start();
  }

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.timer) return;
    const connection = {
      url: this.config.get("REDIS_URL"),
      maxRetriesPerRequest: null,
      connectTimeout: 2_000,
      retryStrategy: (attempt: number) => Math.min(attempt * 500, 5_000),
    };
    this.queue = new Queue<JobData>(this.queueName, {
      connection,
      defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
    });
    this.worker = new Worker<JobData>(
      this.queueName,
      (job: Job<JobData>) => this.processor.process(job.data.tenantId, job.data.work, job.data.refId),
      { connection, concurrency: 4, autorun: true },
    );
    this.queue.on("error", (error: Error) => this.queueDown(error));
    this.worker.on("error", (error: Error) => this.queueDown(error));
    this.timer = setInterval(() => void this.relay(), this.runtime.relayIntervalMs);
    this.timer.unref();
    this.logger.log(`Payments relay started (queue ${this.queueName})`);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    this.worker = null;
    this.queue = null;
  }

  private queueDown(error: unknown) {
    if (Date.now() - this.queueDownLoggedAt > 60_000) {
      this.queueDownLoggedAt = Date.now();
      this.logger.warn(`Payments queue unavailable, processing directly: ${describeError(error)}`);
    }
  }

  private due(batch = 100): Promise<Due[]> {
    return this.prisma.$queryRaw<Due[]>`SELECT tenant_id::text AS tenant_id, work, ref_id::text AS ref_id FROM app.payment_due_work(${batch}::int)`;
  }

  /** Signals new work after a commit (fast path); the interval is the safety net. */
  kick() {
    if (this.timer) setImmediate(() => void this.relay());
  }

  /** One relay pass: enqueue due items, or process them directly when the queue is down. */
  async relay(): Promise<number> {
    if (this.relaying) return 0;
    this.relaying = true;
    try {
      const items = await this.due();
      for (const item of items) {
        const data: JobData = { tenantId: item.tenant_id, work: item.work, refId: item.ref_id };
        const enqueued = await this.enqueue(data);
        if (!enqueued) await this.processor.process(data.tenantId, data.work, data.refId).catch((error: unknown) => this.logger.warn(`Direct payment work failed: ${describeError(error)}`));
      }
      return items.length;
    } catch (error) {
      this.logger.warn(`Payments relay pass failed: ${describeError(error)}`);
      return 0;
    } finally {
      this.relaying = false;
    }
  }

  private markDispatched(data: JobData, at: Date | null) {
    return this.db.run(
      { userId: PAYMENTS_SYSTEM_ACTOR, tenantId: data.tenantId, requestId: `payments-dispatch-${data.refId.slice(0, 8)}` },
      (tx) =>
        tx.paymentOutbox.updateMany({
          where: { tenantId: data.tenantId, id: data.refId, processedAt: null, deadAt: null },
          data: { dispatchedAt: at },
        }),
    );
  }

  /**
   * Marks an outbox row dispatched, then adds the job (ID = row or attempt, so a job already
   * waiting is not added twice; finished jobs are removed so a rescheduled row can be added again).
   * If the queue refuses, the mark is cleared and the caller processes the item directly.
   */
  private async enqueue(data: JobData): Promise<boolean> {
    if (!this.queue) return false;
    if (data.work === "outbox") await this.markDispatched(data, new Date());
    try {
      await Promise.race([
        this.queue.add(data.work, data, { jobId: `${data.work}-${data.refId}` }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("queue add timed out")), 2_000).unref()),
      ]);
      return true;
    } catch (error) {
      this.queueDown(error);
      if (data.work === "outbox") await this.markDispatched(data, null).catch(() => undefined);
      return false;
    }
  }

  /**
   * Processes every due item directly, without the queue, until nothing is due (bounded): the
   * operator's recovery after a queue outage (`pnpm --filter @pm-buddy/api payments:drain`) and the
   * test suite's deterministic driver. Safe to repeat: handlers act only on current state.
   */
  async drain(maxPasses = 20): Promise<number> {
    let processed = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const items = await this.due();
      if (items.length === 0) break;
      for (const item of items) {
        await this.processor.process(item.tenant_id, item.work, item.ref_id);
        processed += 1;
      }
    }
    return processed;
  }
}
