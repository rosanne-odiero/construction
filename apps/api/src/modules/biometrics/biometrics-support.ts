import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { BiometricGateReason } from "@pm-buddy/types";
import { catchError, throwError, type Observable } from "rxjs";
import { AppConfig } from "../../config/app-config.js";
import {
  hasDatabaseCode,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../common/database-errors.js";

/**
 * BIOMETRICS_CAPTURE on this installation (decision D-163, RELEASE_PLAN "Feature gates"). Outside
 * production it is on unless set to `off`; production keeps it off until the D3.4 go-live gates
 * pass (a separately deployed biometrics worker holding its own KMS key, THREAT_MODEL OR-01, and
 * the owner's go-ahead), so an `on` there is logged and ignored. The database cannot read the
 * environment: the API enforces this switch, the database every other part of the gate.
 */
@Injectable()
export class BiometricsPlatform {
  private readonly logger = new Logger(BiometricsPlatform.name);
  private readonly available: boolean;

  constructor(config: AppConfig) {
    const setting = config.get("BIOMETRICS_CAPTURE");
    if (config.isProduction) {
      if (setting === "on")
        this.logger.error(
          "BIOMETRICS_CAPTURE=on is not allowed in production until the D3.4 go-live gates pass; biometric capture stays off",
        );
      this.available = false;
    } else {
      this.available = setting !== "off";
    }
  }

  isAvailable(): boolean {
    return this.available;
  }
}

export type BiometricsProblem =
  | "dpia-draft-exists"
  | "dpia-not-draft"
  | "dpia-not-approved"
  | "dpia-incomplete"
  | "conditions-unconfirmed"
  | "review-date-invalid"
  | "document-changed"
  | "unknown-site"
  | "version-conflict"
  | "file-required"
  | "pdf-required"
  | "unsupported-file-type"
  | "unsafe-archive"
  | "macro-document"
  | "pdf-active-content"
  | "malware-detected"
  | "payload-too-large"
  | "file-integrity"
  | "biometrics-unavailable"
  | "project-read-only"
  | "dpia-required"
  | "dpia-lapsed"
  | "dpia-scope"
  | "biometrics-rule";

export function biometricsProblem(
  status: 400 | 403 | 404 | 409 | 413 | 415 | 422,
  code: BiometricsProblem,
  message: string,
): HttpException {
  const body = { code, message };
  if (status === 403) return new ForbiddenException(body);
  if (status === 404) return new NotFoundException(body);
  if (status === 409) return new ConflictException(body);
  const statuses = {
    400: HttpStatus.BAD_REQUEST,
    413: HttpStatus.PAYLOAD_TOO_LARGE,
    415: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    422: HttpStatus.UNPROCESSABLE_ENTITY,
  } as const;
  return new HttpException(body, statuses[status]);
}

export const versionConflict = () =>
  biometricsProblem(409, "version-conflict", "The DPIA changed since you opened it. Reload it.");

/** The refusal for switching on where the gate is closed (the first failing check). */
export function gateRefusal(reason: Exclude<BiometricGateReason, "switched_off">): HttpException {
  switch (reason) {
    case "platform_off":
      return biometricsProblem(
        409,
        "biometrics-unavailable",
        "Biometric capture is not available on this PM-Buddy installation",
      );
    case "project_closed":
      return biometricsProblem(
        409,
        "project-read-only",
        "Closed and cancelled projects are read-only",
      );
    case "no_dpia":
      return biometricsProblem(409, "dpia-required", "Approve the company's DPIA first");
    case "dpia_lapsed":
      return biometricsProblem(409, "dpia-lapsed", "The DPIA has passed its review date: renew it");
    case "not_in_scope":
      return biometricsProblem(
        409,
        "dpia-scope",
        "The DPIA in force does not cover this site and method",
      );
  }
}

/**
 * Maps a database refusal that the API's own checks did not catch first (a guard trigger, a
 * partial unique index, a privilege) to a problem instead of a 500. The database message is never
 * echoed.
 */
export function biometricsDatabaseProblem(error: unknown): HttpException | null {
  if (error instanceof HttpException) return null;
  if (isUniqueViolation(error) || isCheckViolation(error) || isForeignKeyViolation(error))
    return biometricsProblem(
      409,
      "biometrics-rule",
      "The change breaks a DPIA or biometrics rule.",
    );
  if (hasDatabaseCode(error, ["42501"]))
    return biometricsProblem(403, "biometrics-rule", "This record cannot be changed.");
  return null;
}

/** Applies biometricsDatabaseProblem to every biometrics endpoint. */
@Injectable()
export class BiometricsDatabaseErrors implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) => throwError(() => biometricsDatabaseProblem(error) ?? error)),
      );
  }
}
