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
import { documentsProblem } from "./documents-access.js";

/**
 * Maps a database refusal that the API's own checks did not catch first (a guard trigger, a
 * unique or partial unique index, a commit-time check, a privilege) to a problem instead of a
 * 500. The database message is never echoed.
 */
export function documentsDatabaseProblem(error: unknown): HttpException | null {
  if (error instanceof HttpException) return null;
  if (
    isUniqueViolation(error) ||
    isCheckViolation(error) ||
    isForeignKeyViolation(error) ||
    hasDatabaseCode(error, ["23P01"])
  )
    return documentsProblem(409, "documents-rule", "The change breaks a document rule.");
  if (hasDatabaseCode(error, ["42501"]))
    return documentsProblem(403, "documents-rule", "This record cannot be changed.");
  return null;
}

/** Applies documentsDatabaseProblem to every documents endpoint. */
@Injectable()
export class DocumentsDatabaseErrors implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) => throwError(() => documentsDatabaseProblem(error) ?? error)),
      );
  }
}
