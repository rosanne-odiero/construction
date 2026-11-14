import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { catchError, throwError, type Observable } from "rxjs";
import {
  hasDatabaseCode,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../common/database-errors.js";
import { plantProblem } from "./plant-access.js";

/** The database's own message, wherever the driver adapter put it. */
function databaseMessage(error: unknown): string {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  const messages: string[] = [];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const fields = current as Record<string, unknown>;
    if (typeof fields["message"] === "string") messages.push(fields["message"]);
    pending.push(fields["cause"], fields["meta"], fields["driverAdapterError"]);
  }
  return messages.join(" ");
}

/**
 * Maps a database refusal that the API's own checks did not catch first (a trigger's rule, a
 * unique key, a privilege) to a problem instead of a 500. The database message is never echoed;
 * a refused meter reading keeps its own code so the form can say what to fix.
 */
export function plantDatabaseProblem(error: unknown): HttpException | null {
  if (error instanceof HttpException) return null;
  if (isUniqueViolation(error))
    return plantProblem(409, "plant-rule", "This conflicts with an existing record.");
  if (isCheckViolation(error) && /meter reading cannot be lower/.test(databaseMessage(error)))
    return plantProblem(
      409,
      "meter-out-of-order",
      "A meter reading cannot be lower than an earlier one or higher than a later one.",
    );
  if (isCheckViolation(error) || isForeignKeyViolation(error) || hasDatabaseCode(error, ["23P01"]))
    return plantProblem(409, "plant-rule", "The change breaks a plant rule.");
  if (hasDatabaseCode(error, ["42501"]))
    return plantProblem(403, "plant-rule", "This plant record cannot be changed.");
  return null;
}

/** Applies plantDatabaseProblem to every plant endpoint. */
@Injectable()
export class PlantDatabaseErrors implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(catchError((error: unknown) => throwError(() => plantDatabaseProblem(error) ?? error)));
  }
}
