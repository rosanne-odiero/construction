import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infra/prisma.service.js";

type Context = { userId: string; tenantId: string | null; requestId: string };
type Store = Context & { committed: (() => void)[] };

@Injectable()
export class TenantDatabase {
  private readonly logger = new Logger(TenantDatabase.name);
  private readonly context = new AsyncLocalStorage<Store>();
  constructor(private readonly prisma: PrismaService) {}

  current(): Context {
    const value = this.context.getStore();
    if (!value) throw new Error("Missing authenticated database context");
    return value;
  }

  /**
   * Runs `callback` once the current transaction has committed, and never if it rolls back: for
   * records kept outside the database, such as the biometric journal. A callback that throws is
   * logged and never fails the committed work.
   */
  afterCommit(callback: () => void): void {
    const store = this.context.getStore();
    if (!store) throw new Error("Missing authenticated database context");
    store.committed.push(callback);
  }

  /** `timeoutMs` (default 10 s) bounds long writes such as a BQ commit. */
  async run<T>(
    context: Context,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    timeoutMs = 10_000,
  ): Promise<T> {
    const store: Store = { ...context, committed: [] };
    const result = await this.context.run(store, () =>
      this.prisma.$transaction(
        async (tx) => {
          const current = this.current();
          await tx.$executeRaw`SELECT set_config('app.user_id', ${current.userId}, true),
        set_config('app.tenant_id', ${current.tenantId ?? ""}, true),
        set_config('app.request_id', ${current.requestId}, true)`;
          return operation(tx);
        },
        { timeout: timeoutMs },
      ),
    );
    for (const callback of store.committed) {
      try {
        callback();
      } catch (error) {
        this.logger.warn(`After-commit callback failed: ${(error as Error).name}`);
      }
    }
    return result;
  }
}
