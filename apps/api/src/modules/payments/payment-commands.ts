import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import {
  IDEMPOTENCY_KEY,
  paymentBadRequest,
  paymentConflict,
  requestFingerprint,
  rethrowPaymentDbError,
} from "./payments-support.js";

/**
 * Payment commands (WORKFLOWS shared rules): one serialised company transaction writes the change,
 * its timeline and audit events, outbox work and the stored response. With an Idempotency-Key a
 * retry with the same key and payload returns that response (`Idempotent-Replayed: true`); the same
 * key with another payload or caller is 409 `idempotency-key-reused`. Commands that create money
 * movements require the key.
 */
@Injectable()
export class PaymentCommands {
  constructor(private readonly scope: TenantScope) {}

  run<T>(
    principal: Principal,
    req: Request,
    operation: string,
    payload: unknown,
    command: (
      scope: Scope,
      idempotencyKey: string | null,
      fingerprint: string | null,
    ) => Promise<T>,
    requireKey = false,
  ): Promise<T> {
    const header = req.headers["idempotency-key"];
    const key = typeof header === "string" ? header : undefined;
    if (header !== undefined && (!key || !IDEMPOTENCY_KEY.test(key)))
      throw paymentBadRequest(
        "invalid-idempotency-key",
        "Idempotency-Key must be 8–128 letters, digits, '-' or '_'.",
      );
    if (requireKey && !key)
      throw paymentBadRequest(
        "idempotency-key-required",
        "Send an Idempotency-Key header with every payment instruction.",
      );
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          if (!key) return command(scope, null, null);
          const { tx, access } = scope;
          const fingerprint = requestFingerprint(operation, access.userId, payload);
          const stored = await tx.idempotencyRecord.findUnique({
            where: {
              tenantId_operation_idempotencyKey: {
                tenantId: access.tenantId,
                operation,
                idempotencyKey: key,
              },
            },
          });
          if (stored) {
            if (stored.fingerprint !== fingerprint)
              throw paymentConflict(
                "idempotency-key-reused",
                "This Idempotency-Key was already used for a different request.",
              );
            req.res?.setHeader("Idempotent-Replayed", "true");
            return stored.response as T;
          }
          const result = await command(scope, key, fingerprint);
          await tx.idempotencyRecord.create({
            data: {
              tenantId: access.tenantId,
              operation,
              idempotencyKey: key,
              userId: access.userId,
              fingerprint,
              response: result as Prisma.InputJsonValue,
            },
          });
          return result;
        },
        true,
        30_000,
      )
      .catch((error: unknown) => rethrowPaymentDbError(error));
  }

  read<T>(principal: Principal, req: Request, query: (scope: Scope) => Promise<T>): Promise<T> {
    return this.scope.run(principal, req, query, false, 30_000);
  }
}
