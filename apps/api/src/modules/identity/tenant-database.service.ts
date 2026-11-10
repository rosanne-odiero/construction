import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infra/prisma.service.js";

type Context = { userId: string; tenantId: string | null; requestId: string };

@Injectable()
export class TenantDatabase {
  private readonly context = new AsyncLocalStorage<Context>();
  constructor(private readonly prisma: PrismaService) {}

  current(): Context {
    const value = this.context.getStore();
    if (!value) throw new Error("Missing authenticated database context");
    return value;
  }

  async run<T>(
    context: Context,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.context.run(context, () =>
      this.prisma.$transaction(
        async (tx) => {
          const current = this.current();
          await tx.$executeRaw`SELECT set_config('app.user_id', ${current.userId}, true),
        set_config('app.tenant_id', ${current.tenantId ?? ""}, true),
        set_config('app.request_id', ${current.requestId}, true)`;
          return operation(tx);
        },
        { timeout: 10_000 },
      ),
    );
  }
}
