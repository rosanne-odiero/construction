import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Secret, TOTP } from "otpauth";
import request from "supertest";
import type { App } from "supertest/types.js";
import { expect } from "vitest";
import { z } from "zod";
import {
  bqBillResponseSchema,
  bqCompareResponseSchema,
  bqContractSumResponseSchema,
  bqItemLinkResponseSchema,
  bqVersionResponseSchema,
  bqVersionsResponseSchema,
  buildupResponseSchema,
  buildupsResponseSchema,
  buildupVersionResponseSchema,
  instructionResponseSchema,
  instructionsResponseSchema,
  variationResponseSchema,
  variationsResponseSchema,
  bqImportResponseSchema,
  bqImportsResponseSchema,
  bqPreviewResponseSchema,
  bqResponseSchema,
  bqSearchResponseSchema,
  bqSheetRowsResponseSchema,
  bqTemplateResponseSchema,
  bqTemplatesResponseSchema,
  auditEventsResponseSchema,
  authProvidersResponseSchema,
  authResponseSchema,
  clientProjectResponseSchema,
  clientProjectsResponseSchema,
  csrfResponseSchema,
  diariesResponseSchema,
  diaryResponseSchema,
  invitationResponseSchema,
  membersResponseSchema,
  messageResponseSchema,
  mfaEnrollmentResponseSchema,
  mfaVerificationResponseSchema,
  passkeyAuthenticationOptionsResponseSchema,
  passkeyRegistrationOptionsResponseSchema,
  passkeyRegistrationResponseSchema,
  passkeysResponseSchema,
  permissionCatalogueResponseSchema,
  geofenceHistoryResponseSchema,
  milestoneResponseSchema,
  milestonesResponseSchema,
  projectDetailResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  projectTeamResponseSchema,
  siteResponseSchema,
  sitesResponseSchema,
  wbsNodeResponseSchema,
  wbsResponseSchema,
  roleResponseSchema,
  rolesResponseSchema,
  sessionsResponseSchema,
  tenantCreatedResponseSchema,
  tenantsResponseSchema,
  conversionResponseSchema,
  conversionResultResponseSchema,
  loadDefaultsResponseSchema,
  materialDetailResponseSchema,
  materialResponseSchema,
  materialsResponseSchema,
  priceAlertsResponseSchema,
  priceResponseSchema,
  procurementSettingsResponseSchema,
  supplierDetailResponseSchema,
  supplierRevealResponseSchema,
  suppliersResponseSchema,
  commitmentsResponseSchema,
  grnResponseSchema,
  grnsResponseSchema,
  inboxResponseSchema,
  invoiceDetailResponseSchema,
  invoicesResponseSchema,
  lpoDetailResponseSchema,
  lposResponseSchema,
  procurementDocumentResponseSchema,
  receivableLposResponseSchema,
  requisitionDetailResponseSchema,
  requisitionsResponseSchema,
  rfqDetailResponseSchema,
  rfqsResponseSchema,
  unitResponseSchema,
  unitsResponseSchema,
  accreditationAlertsResponseSchema,
  gangDetailResponseSchema,
  gangsResponseSchema,
  labourerResponseSchema,
  labourersResponseSchema,
  labourRateResponseSchema,
  labourRatesResponseSchema,
  labourSetupResponseSchema,
  labourViewResponseSchema,
  labourViewsResponseSchema,
  resolvedRateResponseSchema,
  revealResponseSchema,
  skillLevelResponseSchema,
  tradeResponseSchema,
  adjustmentResponseSchema,
  adjustmentsResponseSchema,
  anomaliesResponseSchema,
  anomalyResponseSchema,
  attendanceOverviewResponseSchema,
  attendanceSettingsResponseSchema,
  correctionResponseSchema,
  correctionsResponseSchema,
  holidayResponseSchema,
  labourerAttendanceResponseSchema,
  musterResponseSchema,
  periodDetailResponseSchema,
  periodsResponseSchema,
  timesheetLinesResponseSchema,
  timesheetRuleResponseSchema,
  advanceResponseSchema,
  advancesResponseSchema,
  allowanceResponseSchema,
  allowancesResponseSchema,
  batchDetailResponseSchema,
  batchSnapshotResponseSchema,
  exportSummaryResponseSchema,
  minimumWageResponseSchema,
  outputResponseSchema,
  outputsResponseSchema,
  payCalendarResponseSchema,
  payrollOverviewResponseSchema,
  payrollRulesResponseSchema,
  payrollSettingsResponseSchema,
  payslipResponseSchema,
  projectPayrollResponseSchema,
  statutoryRuleResponseSchema,
  workerPortalResponseSchema,
  scheduleActivityResponseSchema,
  scheduleBaselineResponseSchema,
  scheduleBaselinesResponseSchema,
  scheduleCalendarResponseSchema,
  scheduleDelayResponseSchema,
  scheduleDelaysResponseSchema,
  scheduleDependencyResponseSchema,
  scheduleResponseSchema,
  sitePhotosResponseSchema,
  checklistTemplateResponseSchema,
  checklistTemplatesResponseSchema,
  completionResponseSchema,
  cubeSetResponseSchema,
  cubeSetsResponseSchema,
  diaryAttendanceResponseSchema,
  inspectionDetailResponseSchema,
  inspectionsResponseSchema,
  loadStarterTemplatesResponseSchema,
  qualitySettingsResponseSchema,
  qualitySummaryResponseSchema,
  slumpTestResponseSchema,
  slumpTestsResponseSchema,
  snagResponseSchema,
  snagsResponseSchema,
  buildupMaterialsResponseSchema,
  issueOptionsResponseSchema,
  ledgerResponseSchema,
  measurementResponseSchema,
  measurementsResponseSchema,
  movementResponseSchema,
  movementsResponseSchema,
  stockTakeResponseSchema,
  stockTakesResponseSchema,
  storeDetailResponseSchema,
  storesResponseSchema,
  storesSettingsResponseSchema,
  transferResponseSchema,
  transfersResponseSchema,
  transferTargetsResponseSchema,
  varianceResponseSchema,
  type AuthResponse as SharedAuthResponse,
  type PasskeyRegistrationResponse,
} from "@pm-buddy/validation";
import type { CeremonyOverrides, SoftwareAuthenticator } from "./webauthn.js";

/** Shared e2e helpers: a cookie-carrying browser and the response contract of every endpoint. */
export type AuthResponse = SharedAuthResponse & { recoveryCodes?: string[] };
export const password = "Unique construction foundation! 918";
export const origin = "http://localhost:3000";
export const notifications = new Map<string, { subject: string; text: string }[]>();

export function responseContract(method: string, target: string) {
  const path = target.split("?")[0]!;
  if (path === "auth/csrf") return csrfResponseSchema;
  if (path === "auth/providers") return authProvidersResponseSchema;
  if (path === "auth/mfa/enroll") return mfaEnrollmentResponseSchema;
  if (path === "auth/mfa/verify") return mfaVerificationResponseSchema;
  if (path === "auth/sessions" && method === "get") return sessionsResponseSchema;
  if (path === "auth/passkeys" && method === "get") return passkeysResponseSchema;
  if (path === "auth/passkeys/registration/options")
    return passkeyRegistrationOptionsResponseSchema;
  if (path === "auth/passkeys/registration") return passkeyRegistrationResponseSchema;
  if (path === "auth/passkeys/step-up/options") return passkeyAuthenticationOptionsResponseSchema;
  if (
    [
      "auth/login",
      "auth/me",
      "auth/refresh",
      "auth/mfa/step-up",
      "auth/mfa/recover",
      "auth/passkeys/step-up",
      "auth/pin/login",
      "auth/pin/join",
    ].includes(path) ||
    /^tenants\/[^/]+\/select$/.test(path)
  )
    return authResponseSchema;
  if (path === "tenants")
    return method === "get" ? tenantsResponseSchema : tenantCreatedResponseSchema;
  if (path === "tenants/current/members") return membersResponseSchema;
  if (path === "tenants/current/audit") return auditEventsResponseSchema;
  if (path === "tenants/current/invitations") return invitationResponseSchema;
  if (path === "permissions") return permissionCatalogueResponseSchema;
  if (path === "tenants/current/roles")
    return method === "get" ? rolesResponseSchema : roleResponseSchema;
  if (/^tenants\/current\/roles\/[^/]+$/.test(path) && method === "patch")
    return roleResponseSchema;
  if (path === "portal/client/projects") return clientProjectsResponseSchema;
  if (/^portal\/client\/projects\/[^/]+$/.test(path)) return clientProjectResponseSchema;
  if (path === "portal/worker") return workerPortalResponseSchema;
  if (/^projects\/[^/]+\/labourers\/invitations$/.test(path)) return invitationResponseSchema;
  if (path === "projects") return method === "get" ? projectsResponseSchema : projectResponseSchema;
  if (/^projects\/[^/]+\/photos(\?.*)?$/.test(path) && method === "get")
    return sitePhotosResponseSchema;
  if (/^projects\/[^/]+\/diaries\/attendance$/.test(path)) return diaryAttendanceResponseSchema;
  if (/^projects\/[^/]+\/diaries$/.test(path))
    return method === "get" ? diariesResponseSchema : diaryResponseSchema;
  if (/^projects\/[^/]+\/diaries\/[^/]+(\/actions)?$/.test(path)) return diaryResponseSchema;
  if (/^projects\/[^/]+$/.test(path))
    return method === "get" ? projectDetailResponseSchema : projectResponseSchema;
  if (/^projects\/[^/]+\/status$/.test(path)) return projectResponseSchema;
  if (/^projects\/[^/]+\/sites$/.test(path))
    return method === "get" ? sitesResponseSchema : siteResponseSchema;
  if (/^projects\/[^/]+\/sites\/[^/]+(\/geofence)?$/.test(path)) return siteResponseSchema;
  if (/^projects\/[^/]+\/sites\/[^/]+\/geofences$/.test(path)) return geofenceHistoryResponseSchema;
  if (/^projects\/[^/]+\/wbs$/.test(path))
    return method === "get" ? wbsResponseSchema : wbsNodeResponseSchema;
  if (/^projects\/[^/]+\/wbs\/[^/]+$/.test(path) && method === "patch" && !path.endsWith("/order"))
    return wbsNodeResponseSchema;
  if (/^projects\/[^/]+\/milestones$/.test(path))
    return method === "get" ? milestonesResponseSchema : milestoneResponseSchema;
  if (/^projects\/[^/]+\/milestones\/[^/]+(\/status)?$/.test(path) && method !== "delete")
    return milestoneResponseSchema;
  if (/^projects\/[^/]+\/team$/.test(path)) return projectTeamResponseSchema;
  const bqMatch = /^projects\/[^/]+\/bq(\/.*)?$/.exec(path);
  if (bqMatch) {
    const bq = bqMatch[1] ?? "";
    if (bq === "") return bqResponseSchema;
    if (/^\/bills\/[^/]+$/.test(bq)) return bqBillResponseSchema;
    if (bq === "/search") return bqSearchResponseSchema;
    if (/^\/export\/(xlsx|pdf)$/.test(bq) || /^\/imports\/[^/]+\/source$/.test(bq))
      return z.unknown();
    if (bq === "/imports")
      return method === "get" ? bqImportsResponseSchema : bqImportResponseSchema;
    if (/^\/imports\/[^/]+\/sheets\/\d+\/rows$/.test(bq)) return bqSheetRowsResponseSchema;
    if (/^\/imports\/[^/]+\/preview$/.test(bq)) return bqPreviewResponseSchema;
    if (
      /^\/imports\/[^/]+(\/(parse|mapping|apply-template|validate|resolutions|commit|abandon))?$/.test(
        bq,
      )
    )
      return bqImportResponseSchema;
    if (bq === "/templates")
      return method === "get" ? bqTemplatesResponseSchema : bqTemplateResponseSchema;
    if (bq === "/versions") return bqVersionsResponseSchema;
    if (bq === "/versions/compare") return bqCompareResponseSchema;
    if (/^\/versions\/[^/]+\/bills\/[^/]+$/.test(bq)) return bqBillResponseSchema;
    if (/^\/versions\/[^/]+\/approve$/.test(bq)) return bqVersionResponseSchema;
    if (bq === "/contract-sum") return bqContractSumResponseSchema;
    if (bq === "/instructions")
      return method === "get" ? instructionsResponseSchema : instructionResponseSchema;
    if (/^\/instructions\/[^/]+$/.test(bq)) return instructionResponseSchema;
    if (bq === "/variations")
      return method === "get" ? variationsResponseSchema : variationResponseSchema;
    if (/^\/variations\/[^/]+(\/(lines|submit|approve|reject|reopen|cancel|rebase))?$/.test(bq))
      return variationResponseSchema;
    if (/^\/items\/[^/]+\/rate-buildup$/.test(bq)) return bqItemLinkResponseSchema;
  }
  if (/^rate-buildups\/[^/]+\/versions\/\d+\/materials(\/[^/]+)?$/.test(path))
    return buildupMaterialsResponseSchema;
  if (/^projects\/[^/]+\/measurements$/.test(path))
    return method === "get" ? measurementsResponseSchema : measurementResponseSchema;
  const stores = storesContract(method, path);
  if (stores) return stores;
  if (path === "rate-buildups")
    return method === "get" ? buildupsResponseSchema : buildupResponseSchema;
  if (/^rate-buildups\/[^/]+$/.test(path)) return buildupResponseSchema;
  if (/^rate-buildups\/[^/]+\/versions\/\d+$/.test(path)) return buildupVersionResponseSchema;
  const procurement = procurementContract(method, path);
  if (procurement) return procurement;
  const labour = labourContract(method, path);
  if (labour) return labour;
  const attendance = attendanceContract(path);
  if (attendance) return attendance;
  const payroll = payrollContract(method, path);
  if (payroll) return payroll;
  const p2p = procureToPayContract(method, path);
  if (p2p) return p2p;
  const schedule = scheduleContract(method, path);
  if (schedule) return schedule;
  const quality = qualityContract(method, path);
  if (quality) return quality;
  return messageResponseSchema;
}

/** The D6.1 quality endpoints' success contracts. */
function qualityContract(method: string, path: string) {
  if (path === "quality/templates")
    return method === "get" ? checklistTemplatesResponseSchema : checklistTemplateResponseSchema;
  if (path === "quality/templates/starter") return loadStarterTemplatesResponseSchema;
  if (/^quality\/templates\/[^/]+(\/(versions|retire))?$/.test(path))
    return checklistTemplateResponseSchema;
  if (path === "quality/settings") return qualitySettingsResponseSchema;
  const match = /^projects\/[^/]+\/quality(\/.*)?$/.exec(path);
  if (!match) return null;
  const rest = match[1] ?? "";
  if (rest === "/summary") return qualitySummaryResponseSchema;
  if (rest === "/inspections")
    return method === "get" ? inspectionsResponseSchema : inspectionDetailResponseSchema;
  if (/^\/inspections\/[^/]+(\/actions)?$/.test(rest)) return inspectionDetailResponseSchema;
  if (rest === "/snags") return method === "get" ? snagsResponseSchema : snagResponseSchema;
  if (/^\/snags\/[^/]+(\/actions)?$/.test(rest)) return snagResponseSchema;
  if (rest === "/cubes") return method === "get" ? cubeSetsResponseSchema : cubeSetResponseSchema;
  if (/^\/cubes\/[^/]+(\/(results|void)|\/results\/[^/]+\/corrections)?$/.test(rest))
    return cubeSetResponseSchema;
  if (rest === "/slump-tests")
    return method === "get" ? slumpTestsResponseSchema : slumpTestResponseSchema;
  if (/^\/slump-tests\/[^/]+(\/corrections)?$/.test(rest)) return slumpTestResponseSchema;
  if (/^\/completion(\/[^/]+\/actions)?$/.test(rest)) return completionResponseSchema;
  return null;
}

/** The D6.2 schedule endpoints' success contracts. */
function scheduleContract(method: string, path: string) {
  const match = /^projects\/[^/]+\/schedule(\/.*)?$/.exec(path);
  if (!match) return null;
  const rest = match[1] ?? "";
  if (rest === "") return scheduleResponseSchema;
  if (rest === "/calendar") return scheduleCalendarResponseSchema;
  if (method === "delete") return messageResponseSchema;
  if (/^\/activities(\/[^/]+(\/progress)?)?$/.test(rest)) return scheduleActivityResponseSchema;
  if (/^\/dependencies(\/[^/]+)?$/.test(rest)) return scheduleDependencyResponseSchema;
  if (rest === "/baselines")
    return method === "get" ? scheduleBaselinesResponseSchema : scheduleBaselineResponseSchema;
  if (/^\/baselines\/[^/]+$/.test(rest)) return scheduleBaselineResponseSchema;
  if (rest === "/delays")
    return method === "get" ? scheduleDelaysResponseSchema : scheduleDelayResponseSchema;
  if (/^\/delays\/[^/]+(\/(amend|withdraw))?$/.test(rest)) return scheduleDelayResponseSchema;
  return null;
}

/** The D5.2 procure-to-pay endpoints' success contracts. */
function procureToPayContract(method: string, path: string) {
  const match = /^procurement\/(requisitions|rfqs|lpos|grns|invoices)(\/.*)?$/.exec(path);
  if (path === "procurement/inbox") return inboxResponseSchema;
  if (path === "procurement/commitments") return commitmentsResponseSchema;
  if (/^procurement\/documents\/[^/]+$/.test(path)) return z.unknown();
  if (!match) return null;
  const [, area, rest = ""] = match;
  if (/\/(document|photos)$/.test(rest)) return procurementDocumentResponseSchema;
  if (area === "requisitions")
    return rest === "" && method === "get"
      ? requisitionsResponseSchema
      : requisitionDetailResponseSchema;
  if (area === "rfqs") {
    if (rest === "" && method === "get") return rfqsResponseSchema;
    return rest.endsWith("/award") ? lpoDetailResponseSchema : rfqDetailResponseSchema;
  }
  if (area === "lpos") return rest === "" ? lposResponseSchema : lpoDetailResponseSchema;
  if (area === "grns") {
    if (rest === "/receivable") return receivableLposResponseSchema;
    return rest === "" && method === "get" ? grnsResponseSchema : grnResponseSchema;
  }
  return rest === "" && method === "get" ? invoicesResponseSchema : invoiceDetailResponseSchema;
}

/** The D5.3 stores endpoints' success contracts. */
function storesContract(method: string, path: string) {
  const get = method === "get";
  if (path === "stores") return get ? storesResponseSchema : storeDetailResponseSchema;
  if (path === "stores/settings") return storesSettingsResponseSchema;
  if (path === "stores/variance") return varianceResponseSchema;
  if (/^stores\/[^/]+\/ledger$/.test(path)) return ledgerResponseSchema;
  if (/^stores\/[^/]+\/issue-options$/.test(path)) return issueOptionsResponseSchema;
  if (/^stores\/[^/]+\/transfer-targets$/.test(path)) return transferTargetsResponseSchema;
  if (/^stores\/[^/]+(\/reorder-levels)?$/.test(path)) return storeDetailResponseSchema;
  if (path === "stock-movements") return movementsResponseSchema;
  if (/^stock-movements\/.+$/.test(path)) return movementResponseSchema;
  if (path === "stock-transfers") return get ? transfersResponseSchema : transferResponseSchema;
  if (/^stock-transfers\/.+$/.test(path)) return transferResponseSchema;
  if (path === "stock-takes") return get ? stockTakesResponseSchema : stockTakeResponseSchema;
  if (/^stock-takes\/.+$/.test(path)) return stockTakeResponseSchema;
  return null;
}

/** The D5.1 catalogue and supplier endpoints' success contracts. */
function procurementContract(method: string, path: string) {
  if (path === "materials")
    return method === "get" ? materialsResponseSchema : materialResponseSchema;
  if (path === "materials/defaults") return loadDefaultsResponseSchema;
  if (/^materials\/[^/]+$/.test(path))
    return method === "get" ? materialDetailResponseSchema : materialResponseSchema;
  if (/^materials\/[^/]+\/conversions(\/[^/]+\/end)?$/.test(path)) return conversionResponseSchema;
  if (/^materials\/[^/]+\/prices(\/[^/]+\/corrections)?$/.test(path)) return priceResponseSchema;
  if (path === "price-alerts") return priceAlertsResponseSchema;
  if (path === "conversions/calculate") return conversionResultResponseSchema;
  if (path === "units") return method === "get" ? unitsResponseSchema : unitResponseSchema;
  if (/^units\/[^/]+$/.test(path)) return unitResponseSchema;
  if (path === "procurement/settings") return procurementSettingsResponseSchema;
  if (path === "suppliers")
    return method === "get" ? suppliersResponseSchema : supplierDetailResponseSchema;
  if (/^suppliers\/[^/]+\/reveal$/.test(path)) return supplierRevealResponseSchema;
  if (/^suppliers\/[^/]+(\/payout-details(\/[^/]+\/(verify|reject))?)?$/.test(path))
    return supplierDetailResponseSchema;
  return null;
}

/** The D4.1 payroll endpoints' success contracts. */
function payrollContract(method: string, path: string) {
  if (!path.startsWith("payroll/")) return null;
  const get = method === "get";
  if (path === "payroll/overview") return payrollOverviewResponseSchema;
  if (path === "payroll/settings") return payrollSettingsResponseSchema;
  if (/^payroll\/projects\/[^/]+\/calendar$/.test(path)) return payCalendarResponseSchema;
  if (path === "payroll/rules")
    return get ? payrollRulesResponseSchema : statutoryRuleResponseSchema;
  if (path === "payroll/rules/defaults") return payrollRulesResponseSchema;
  if (/^payroll\/rules\/[^/]+\/verify$/.test(path)) return statutoryRuleResponseSchema;
  if (/^payroll\/rules\/[^/]+$/.test(path)) return messageResponseSchema;
  if (path === "payroll/minimum-wages") return minimumWageResponseSchema;
  if (/^payroll\/projects\/[^/]+$/.test(path)) return projectPayrollResponseSchema;
  if (/^payroll\/projects\/[^/]+\/batches$/.test(path)) return batchDetailResponseSchema;
  if (/^payroll\/batches\/[^/]+(\/(recalculate|submit|cancel))?$/.test(path))
    return batchDetailResponseSchema;
  if (/^payroll\/batches\/[^/]+\/lines\/[^/]+$/.test(path)) return payslipResponseSchema;
  if (/^payroll\/batches\/[^/]+\/snapshot$/.test(path)) return batchSnapshotResponseSchema;
  if (/^payroll\/projects\/[^/]+\/allowances$/.test(path))
    return get ? allowancesResponseSchema : allowanceResponseSchema;
  if (/^payroll\/allowances\/[^/]+\/end$/.test(path)) return allowanceResponseSchema;
  if (/^payroll\/projects\/[^/]+\/outputs$/.test(path))
    return get ? outputsResponseSchema : outputResponseSchema;
  if (/^payroll\/outputs\/[^/]+\/(approve|reject)$/.test(path)) return outputResponseSchema;
  if (path === "payroll/advances") return advancesResponseSchema;
  if (/^payroll\/projects\/[^/]+\/advances$/.test(path)) return advanceResponseSchema;
  if (/^payroll\/advances\/[^/]+\/(approve|reject|disburse|cancel)$/.test(path))
    return advanceResponseSchema;
  if (path === "payroll/exports") return get ? exportSummaryResponseSchema : z.unknown();
  return null;
}

/** The D3.3 attendance and timesheet endpoints' success contracts. */
function attendanceContract(path: string) {
  if (!path.startsWith("attendance/")) return null;
  if (path === "attendance/overview") return attendanceOverviewResponseSchema;
  if (
    [
      "attendance/settings",
      "attendance/settings/periods",
      "attendance/rules/defaults",
      "attendance/holidays/defaults",
    ].includes(path)
  )
    return attendanceSettingsResponseSchema;
  if (path === "attendance/rules") return timesheetRuleResponseSchema;
  if (path === "attendance/holidays") return holidayResponseSchema;
  if (/^attendance\/(rules|holidays)\/[^/]+$/.test(path)) return messageResponseSchema;
  if (/^attendance\/projects\/[^/]+\/muster$/.test(path)) return musterResponseSchema;
  if (/^attendance\/days\/[^/]+\/(submit|confirm|return)$/.test(path)) return musterResponseSchema;
  if (/^attendance\/days\/[^/]+\/corrections$/.test(path)) return correctionResponseSchema;
  if (/^attendance\/projects\/[^/]+\/corrections$/.test(path)) return correctionsResponseSchema;
  if (/^attendance\/corrections\/[^/]+\/(approve|reject)$/.test(path))
    return correctionResponseSchema;
  if (path === "attendance/anomalies") return anomaliesResponseSchema;
  if (/^attendance\/anomalies\/[^/]+\/review$/.test(path)) return anomalyResponseSchema;
  if (/^attendance\/projects\/[^/]+\/periods$/.test(path)) return periodsResponseSchema;
  if (/^attendance\/periods\/[^/]+\/lines$/.test(path)) return timesheetLinesResponseSchema;
  if (/^attendance\/periods\/[^/]+\/adjustments$/.test(path)) return adjustmentResponseSchema;
  if (/^attendance\/periods\/[^/]+(\/(submit|approve|reject|reopen))?$/.test(path))
    return periodDetailResponseSchema;
  if (/^attendance\/projects\/[^/]+\/adjustments$/.test(path)) return adjustmentsResponseSchema;
  if (/^attendance\/adjustments\/[^/]+\/(approve|reject)$/.test(path))
    return adjustmentResponseSchema;
  if (/^attendance\/labourers\/[^/]+\/summary$/.test(path)) return labourerAttendanceResponseSchema;
  return null;
}

/** The D3.1 labour endpoints' success contracts. */
function labourContract(method: string, path: string) {
  if (!path.startsWith("labour/")) return null;
  if (["labour/setup", "labour/setup/defaults", "labour/settings"].includes(path))
    return labourSetupResponseSchema;
  if (/^labour\/trades(\/[^/]+)?$/.test(path)) return tradeResponseSchema;
  if (/^labour\/skill-levels(\/[^/]+)?$/.test(path)) return skillLevelResponseSchema;
  if (path === "labour/rates")
    return method === "get" ? labourRatesResponseSchema : labourRateResponseSchema;
  if (path === "labour/labourers")
    return method === "get" ? labourersResponseSchema : labourerResponseSchema;
  if (path === "labour/labourers/lookup") return labourersResponseSchema;
  if (/^labour\/labourers\/[^/]+\/reveal$/.test(path)) return revealResponseSchema;
  if (/^labour\/labourers\/[^/]+\/rate$/.test(path)) return resolvedRateResponseSchema;
  if (/^labour\/labourers\/[^/]+(\/.*)?$/.test(path)) return labourerResponseSchema;
  if (path === "labour/accreditation-alerts") return accreditationAlertsResponseSchema;
  if (path === "labour/views")
    return method === "get" ? labourViewsResponseSchema : labourViewResponseSchema;
  if (path === "labour/gangs")
    return method === "get" ? gangsResponseSchema : gangDetailResponseSchema;
  if (/^labour\/gangs\/[^/]+(\/.*)?$/.test(path)) return gangDetailResponseSchema;
  return null;
}

export class Browser {
  readonly cookies = new Map<string, string>();
  csrf = "";
  auth!: AuthResponse;
  identifier = `${randomUUID()}@example.test`;
  mfaSecret = "";
  enrollmentCode = "";
  constructor(private readonly app: INestApplication<App>) {}

  async call(
    method: "get" | "post" | "delete" | "patch" | "put",
    path: string,
    body?: object,
    csrf = true,
    headers: Record<string, string> = {},
  ): Promise<request.Response> {
    const operation = request(this.app.getHttpServer())[method](`/api/v1/${path}`);
    operation.set("Cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    operation.set("Origin", origin);
    if (csrf) operation.set("X-CSRF-Token", this.csrf);
    for (const [key, value] of Object.entries(headers)) operation.set(key, value);
    for (const [name, value] of Object.entries(headers)) operation.set(name, value);
    const res = body === undefined ? await operation : await operation.send(body);
    if (res.status >= 200 && res.status < 300) {
      expect(
        responseContract(method, path).safeParse(res.body).success,
        `Wire contract mismatch for ${method.toUpperCase()} ${path}: ${JSON.stringify(res.body)}`,
      ).toBe(true);
    }
    const values = res.headers["set-cookie"] as unknown as string[] | undefined;
    for (const value of values ?? []) {
      const pair = value.split(";")[0]!;
      const position = pair.indexOf("=");
      this.cookies.set(pair.slice(0, position), pair.slice(position + 1));
    }
    return res;
  }

  /** A multipart upload of one file as the `file` field (as the web app sends it). */
  async upload(path: string, content: Buffer, fileName: string): Promise<request.Response> {
    const operation = request(this.app.getHttpServer()).post(`/api/v1/${path}`);
    operation.set("Cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    operation.set("Origin", origin);
    operation.set("X-CSRF-Token", this.csrf);
    const res = await operation.attach("file", content, fileName);
    if (res.status >= 200 && res.status < 300)
      expect(
        responseContract("post", path).safeParse(res.body).success,
        `Wire contract mismatch for upload ${path}: ${JSON.stringify(res.body)}`,
      ).toBe(true);
    return res;
  }

  /** A GET whose body is a file (exports, sources). */
  async download(path: string): Promise<request.Response> {
    return request(this.app.getHttpServer())
      .get(`/api/v1/${path}`)
      .set("Cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
  }

  async initialize() {
    const res = await this.call("get", "auth/csrf");
    expect(res.status).toBe(200);
    this.csrf = (res.body as { csrfToken: string }).csrfToken;
  }

  async register() {
    await this.initialize();
    const res = await this.call("post", "auth/register", {
      identifier: this.identifier,
      password,
      displayName: "Foundation test user",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const text = notifications.get(this.identifier)?.at(-1)?.text;
    const code = text?.match(/Verification code: (\d{6})/)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    const verified = await this.call("post", "auth/verify", {
      identifier: this.identifier,
      code,
      password,
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    await this.login();
  }

  async login(): Promise<request.Response> {
    const res = await this.call("post", "auth/login", { identifier: this.identifier, password });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    this.auth = res.body as AuthResponse;
    return res;
  }

  code(offset = 0) {
    return new TOTP({ secret: Secret.fromBase32(this.mfaSecret) }).generate({
      timestamp: Date.now() + offset,
    });
  }

  async enroll() {
    const start = await this.call("post", "auth/mfa/enroll", {});
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    this.mfaSecret = (start.body as { secret: string }).secret;
    this.enrollmentCode = this.code();
    const verified = await this.call("post", "auth/mfa/verify", { code: this.enrollmentCode });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    this.auth = verified.body as AuthResponse;
    expect(this.auth.recoveryCodes).toHaveLength(10);
  }

  /** Runs a real WebAuthn registration ceremony with a software authenticator. */
  async registerPasskey(
    authenticator: SoftwareAuthenticator,
    name = "Test passkey",
    overrides: CeremonyOverrides = {},
  ): Promise<request.Response> {
    const options = await this.call("post", "auth/passkeys/registration/options", {});
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    const credential = authenticator.register(
      passkeyRegistrationOptionsResponseSchema.parse(options.body).options,
      overrides,
    );
    const res = await this.call("post", "auth/passkeys/registration", { name, credential });
    if (res.status === 201) this.auth = res.body as PasskeyRegistrationResponse;
    return res;
  }

  /** Requests step-up options, then answers them with an assertion (optionally tampered with). */
  async passkeyStepUp(
    authenticator: SoftwareAuthenticator,
    overrides: CeremonyOverrides = {},
  ): Promise<request.Response> {
    const options = await this.call("post", "auth/passkeys/step-up/options", {});
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    const credential = authenticator.assert(
      passkeyAuthenticationOptionsResponseSchema.parse(options.body).options,
      overrides,
    );
    const res = await this.call("post", "auth/passkeys/step-up", { credential });
    if (res.status === 200) this.auth = res.body as AuthResponse;
    return res;
  }
}
