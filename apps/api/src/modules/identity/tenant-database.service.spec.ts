import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../infra/prisma.service.js";
import { TenantDatabase } from "./tenant-database.service.js";

const context = { userId: "user", tenantId: "tenant", requestId: "request" };

/** A Prisma stand-in whose commit succeeds unless `commitFails`. */
function database(commitFails = false) {
  const tx = { $executeRaw: async () => 0 };
  const prisma = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => {
      const result = await operation(tx);
      if (commitFails) throw new Error("deferred constraint failed at commit");
      return result;
    },
  };
  return new TenantDatabase(prisma as unknown as PrismaService);
}

describe("TenantDatabase.afterCommit", () => {
  it("runs callbacks in order once the transaction has committed", async () => {
    const db = database();
    const calls: string[] = [];
    const result = await db.run(context, async () => {
      db.afterCommit(() => calls.push("first"));
      db.afterCommit(() => calls.push("second"));
      expect(calls).toEqual([]);
      return "done";
    });
    expect(result).toBe("done");
    expect(calls).toEqual(["first", "second"]);
  });

  it("never runs them when the work or the commit fails", async () => {
    const calls: string[] = [];
    const failing = database();
    await expect(
      failing.run(context, async () => {
        failing.afterCommit(() => calls.push("rolled back"));
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    const commit = database(true);
    await expect(
      commit.run(context, async () => commit.afterCommit(() => calls.push("not committed"))),
    ).rejects.toThrow(/at commit/);
    expect(calls).toEqual([]);
  });

  it("logs a failing callback without failing the committed work, and needs a transaction", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const db = database();
    const calls: string[] = [];
    await expect(
      db.run(context, async () => {
        db.afterCommit(() => {
          throw new TypeError("journal unavailable");
        });
        db.afterCommit(() => calls.push("after"));
        return 1;
      }),
    ).resolves.toBe(1);
    expect(calls).toEqual(["after"]);
    expect(warn).toHaveBeenCalledWith("After-commit callback failed: TypeError");
    expect(() => db.afterCommit(() => undefined)).toThrow(/Missing authenticated/);
    warn.mockRestore();
  });
});
