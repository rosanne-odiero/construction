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
import { safetyProblem } from "./safety-access.js";

/**
 * Maps a database refusal that the API's own checks did not catch first (a trigger's rule, a
 * unique key, a privilege) to a problem instead of a 500. The database message is not echoed: it
 * can name people or injuries. Anything else is returned unchanged (null).
 */
export function safetyDatabaseProblem(error: unknown): HttpException | null {
  if (error instanceof HttpException) return null;
  if (isUniqueViolation(error))
    return safetyProblem(409, "safety-rule", "This conflicts with an existing record.");
  if (isCheckViolation(error) || isForeignKeyViolation(error) || hasDatabaseCode(error, ["23P01"]))
    return safetyProblem(409, "safety-rule", "The change breaks a health and safety rule.");
  if (hasDatabaseCode(error, ["42501"]))
    return safetyProblem(403, "safety-rule", "This health and safety record cannot be changed.");
  return null;
}

/** Applies safetyDatabaseProblem to every health and safety endpoint. */
@Injectable()
export class SafetyDatabaseErrors implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) => throwError(() => safetyDatabaseProblem(error) ?? error)),
      );
  }
}
