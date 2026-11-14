import { createHash } from "node:crypto";
import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import type { Request } from "express";
import {
  clientProgress,
  clientRequestOpen,
  clientRequestState,
  nairobiDate,
  PHOTO_LIMITS,
  progressPercent,
  receiptFits,
  sCurve,
  weekEnds,
} from "@pm-buddy/domain";
import {
  CLIENT_PAYMENT_READ_PERMISSIONS,
  CLIENT_PORTAL_LIMITS,
  STK_PUSH_AVAILABLE,
  VALUATION_LIMITS,
  type ClientDecision,
  type DisplayCurrency,
  type MilestoneStatus,
  type PaybillAccountFormat,
  type VariationStatus,
} from "@pm-buddy/types";
import {
  clientDecisionSchema,
  clientDiariesResponseSchema,
  clientPayResponseSchema,
  clientPhotosResponseSchema,
  clientPortalOverviewResponseSchema,
  clientPortalProjectsResponseSchema,
  clientPreferencesResponseSchema,
  clientProgressResponseSchema,
  clientStatementResponseSchema,
  clientVariationDetailResponseSchema,
  clientVariationsResponseSchema,
  clientVariationViewSchema,
  workforceTradeSchema,
  type ClientCertificate,
  type ClientDecisionRequest,
  type ClientReceipt,
  type ClientStatementResponse,
  type ClientStkPushRequest,
  type PaymentInstructions,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../../common/database-errors.js";
import { uuidv7 } from "../../../common/uuid.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { StorageService } from "../../../infra/storage.service.js";
import {
  loadClientLedger,
  type LedgerCertificate,
  type LedgerPayment,
  type PaymentInstructionsRow,
} from "../../finance/client-ledger.js";
import type { Scope } from "../../identity/access-policy.js";
import { AuthSecurity } from "../../identity/auth-security.service.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { peopleOf, personOf, toCalendarDate } from "../../procurement/procurement-mappers.js";
import { plannedAndEarned } from "../../progress/valuations/earned-value.service.js";
import { toProject } from "../../projects/project-mappers.js";
import { ClientPaymentRequests } from "./client-payment-requests.js";
import {
  ClientPortalAccess,
  clientPortalProblem,
  staffProject,
  type ClientProjectRow,
} from "./client-portal-access.js";
import { clientProjectRef, displayFor, fxRateWire, latestRates } from "./client-display.js";

type Tx = Prisma.TransactionClient;
type DiaryRow = Prisma.SiteDiaryGetPayload<{ include: { site: { select: { name: true } } } }>;
type RequestRow = Prisma.VariationClientRequestGetPayload<{
  include: { decisions: true; variation: true };
}>;

const OVERVIEW_DIARIES = 5;

export const certificateWire = (row: LedgerCertificate): ClientCertificate => ({
  id: row.id,
  number: row.number,
  kind: row.kind,
  releaseStage: row.releaseStage,
  valuationDate: row.valuationDate,
  certifiedOn: row.certifiedOn,
  dueDate: row.dueDate,
  amountDueMinor: row.amountDueMinor,
  vatPercent: row.vatPercent,
  vatMinor: row.vatMinor,
  totalMinor: row.totalMinor,
  receivedMinor: row.receivedMinor,
  creditedMinor: row.creditedMinor,
  outstandingMinor: row.outstandingMinor,
  state: row.state,
  overdue: row.overdue,
  overdueDays: row.overdueDays,
  accountReference: row.accountReference,
});

/** A receipt as the client sees it: never the staff note or who recorded it. */
export const receiptWire = (row: LedgerPayment): ClientReceipt => ({
  id: row.id,
  kind: row.kind,
  certificateId: row.certificateId,
  certificateNumber: row.certificateNumber,
  receivedOn: row.receivedOn,
  amountMinor: row.amountMinor,
  method: row.method,
  reference: row.reference,
  reversesId: row.reversesId,
  reason: row.reason,
  reversed: row.reversedBy !== null,
  recordedAt: row.recordedAt,
});

export const instructionsWire = (row: PaymentInstructionsRow | null): PaymentInstructions | null =>
  row
    ? {
        version: row.version,
        paybillNumber: row.paybillNumber,
        tillNumber: row.tillNumber,
        accountName: row.accountName,
        accountFormat: row.accountFormat as PaybillAccountFormat,
        bankInstructions: row.bankInstructions,
        updatedAt: row.createdAt.toISOString(),
      }
    : null;

const totalsOf = (ledger: Awaited<ReturnType<typeof loadClientLedger>>) => ({
  certifiedMinor: ledger.statement.certifiedMinor,
  receivedMinor: ledger.statement.receivedMinor,
  outstandingMinor: ledger.statement.outstandingMinor,
  overdueMinor: ledger.statement.overdueMinor,
});

/** What happened to a variation, said the way a client needs it. */
const outcomeOf = (status: VariationStatus) =>
  status === "approved" || status === "rejected" || status === "cancelled" ? status : "in_review";

/** A diary as the client sees it: the workforce as headcounts by trade, never people. */
function diaryWire(row: DiaryRow) {
  const trades =
    row.workforceSource === "attendance"
      ? workforceTradeSchema.array().parse(row.workforceByTrade)
      : null;
  return {
    id: row.id,
    date: toCalendarDate(row.date),
    siteName: row.site.name,
    workPerformed: row.workPerformed,
    weather: row.weather,
    delays: row.delays,
    workforceCount: row.workforceCount,
    workforce: trades
      ? {
          total: row.workforceCount ?? trades.reduce((sum, trade) => sum + trade.headcount, 0),
          trades: trades.map((trade) => ({
            key: trade.key,
            nameEn: trade.nameEn,
            nameSw: trade.nameSw,
            headcount: trade.headcount,
          })),
        }
      : null,
    approvedAt: row.reviewedAt!.toISOString(),
  };
}

/**
 * The client portal (D7.1, brief §5.10, ARCHITECTURE §4.15): read-only views of the client's
 * assigned projects — earned-value progress and the S-curve (no cost data), the verified photo
 * timeline (general photos with their checks; thumbnails only), approved diaries with workforce
 * counts by trade, certified certificates with what the company recorded as received, how to pay
 * (Paybill; STK Push behind a disabled boundary until D4.2), variations sent for a decision and
 * the display currency. Every query is scoped to a project the client is assigned to
 * (ClientPortalAccess; restrictive RLS repeats it).
 */
@Injectable()
export class ClientPortalService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ClientPortalAccess,
    private readonly storage: StorageService,
    private readonly security: AuthSecurity,
    private readonly payments: ClientPaymentRequests,
  ) {}

  // Projects and overview ---------------------------------------------------------------------

  projects(principal: Principal, override: DisplayCurrency | undefined, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const rows = await this.access.projects(scope);
      const [company, display, awaiting] = await Promise.all([
        tx.tenant.findUniqueOrThrow({
          where: { id: access.tenantId },
          select: { id: true, name: true },
        }),
        displayFor(tx, access.tenantId, access.userId, override),
        this.awaitingByProject(
          tx,
          access.tenantId,
          rows.map((row) => row.id),
        ),
      ]);
      const projects = [];
      for (const row of rows)
        projects.push(await this.projectWire(tx, access.tenantId, row, awaiting.get(row.id) ?? 0));
      return clientPortalProjectsResponseSchema.parse({ company, projects, display });
    });
  }

  overview(
    principal: Principal,
    projectId: string,
    override: DisplayCurrency | undefined,
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.access.project(scope, projectId);
      const today = nairobiDate();
      const [ledger, awaiting, milestones, diaries, progress, photos, display] = await Promise.all([
        loadClientLedger(tx, access.tenantId, projectId, project.code, today),
        this.awaitingByProject(tx, access.tenantId, [projectId]),
        tx.milestone.findMany({
          where: { tenantId: access.tenantId, projectId },
          orderBy: [{ dueDate: "asc" }, { name: "asc" }],
        }),
        tx.siteDiary.findMany({
          where: { tenantId: access.tenantId, projectId, status: "approved" },
          include: { site: { select: { name: true } } },
          orderBy: [{ date: "desc" }, { id: "desc" }],
          take: OVERVIEW_DIARIES,
        }),
        this.progressFigures(tx, access.tenantId, projectId, today),
        this.photoCounts(tx, access.tenantId, projectId),
        displayFor(tx, access.tenantId, access.userId, override),
      ]);
      const next = ledger.certificates
        .filter((row) => row.outstandingMinor > 0)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
      return clientPortalOverviewResponseSchema.parse({
        project: this.projectShape(project, milestones, ledger, awaiting.get(projectId) ?? 0),
        progress: {
          dataDate: today,
          percentComplete: progress.figures.percentComplete,
          plannedPercent: progress.figures.plannedPercent,
          variancePoints: progress.figures.variancePoints,
          bqVersionNo: progress.version?.versionNo ?? null,
          baselineName: progress.baseline?.name ?? null,
        },
        milestones: milestones.map((row) => this.milestoneWire(row)),
        diaries: diaries.map(diaryWire),
        nextDue: next
          ? {
              certificateId: next.id,
              number: next.number,
              dueDate: next.dueDate,
              outstandingMinor: next.outstandingMinor,
              overdue: next.overdue,
            }
          : null,
        photos,
        display,
      });
    });
  }

  // Progress ------------------------------------------------------------------------------------

  progress(
    principal: Principal,
    projectId: string,
    asOf: string | undefined,
    override: DisplayCurrency | undefined,
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.access.project(scope, projectId);
      const today = nairobiDate();
      if (asOf && asOf > today)
        throw new BadRequestException({
          code: "as-of-future",
          message: "Progress is reported up to today",
        });
      const dataDate = asOf ?? today;
      const progress = await this.progressFigures(tx, access.tenantId, projectId, dataDate);
      const { bacMinor, evChanges, ev, pv, baselineFinish } = progress;
      const firstDates = [
        ...evChanges.map((change) => change.date),
        ...(pv ? [pv.span.start] : []),
      ].sort();
      const from = firstDates[0] ?? dataDate;
      const to = baselineFinish && baselineFinish > dataDate ? baselineFinish : dataDate;
      const all = weekEnds(from < dataDate ? from : dataDate, to, Number.MAX_SAFE_INTEGER);
      const weeks = all.slice(-VALUATION_LIMITS.sCurveMaxWeeks);
      // The client's S-curve: planned and earned value at contract rates; never actual cost.
      const curve = sCurve({
        weekEnds: weeks,
        dataDate,
        pv: pv ? (date) => pv.at(date) : null,
        ev,
        ac: () => 0,
      }).map((point) => ({
        weekEnd: point.weekEnd,
        pvMinor: point.pvMinor,
        evMinor: point.evMinor,
        plannedPercent: progressPercent(point.pvMinor, bacMinor),
        earnedPercent: progressPercent(point.evMinor, bacMinor),
      }));
      const milestones = await tx.milestone.findMany({
        where: { tenantId: access.tenantId, projectId },
        orderBy: [{ dueDate: "asc" }, { name: "asc" }],
      });
      return clientProgressResponseSchema.parse({
        project: clientProjectRef(project),
        dataDate,
        bqVersion: progress.version ? { versionNo: progress.version.versionNo } : null,
        baseline: progress.baseline
          ? {
              name: progress.baseline.name,
              startDate: toCalendarDate(progress.baseline.startDate),
              finishDate: baselineFinish,
            }
          : null,
        figures: {
          bacMinor,
          evMinor: ev(dataDate),
          pvMinor: pv ? pv.at(dataDate) : null,
          ...progress.figures,
        },
        curve,
        curveTruncated: all.length > weeks.length,
        milestones: milestones.map((row) => this.milestoneWire(row)),
        display: await displayFor(tx, access.tenantId, access.userId, override),
      });
    });
  }

  // Photos and diaries ------------------------------------------------------------------------

  photos(
    principal: Principal,
    projectId: string,
    query: { cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.access.project(scope, projectId);
      // General photos only: incident photos (D8.2) never reach a client (RLS repeats it).
      const rows = await tx.sitePhoto.findMany({
        where: {
          tenantId: access.tenantId,
          projectId,
          purpose: "general",
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        include: { site: { select: { name: true } } },
        orderBy: { id: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return clientPhotosResponseSchema.parse({
        project: clientProjectRef(project),
        // No coordinates, uploader or file names: the site, the claimed capture time, when the
        // server received it and the server's checks with their limitations.
        photos: page.map((row) => ({
          id: row.id,
          siteName: row.site.name,
          caption: row.caption,
          capturedAt: row.capturedAt?.toISOString() ?? null,
          timeSource: row.timeSource,
          uploadedAt: row.uploadedAt.toISOString(),
          verified: row.verified,
          checks: {
            location: row.locationCheck,
            time: row.timeCheck,
            distanceM: row.distanceM === null ? null : row.distanceM.toNumber(),
          },
          width: row.width,
          height: row.height,
        })),
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
        counts: await this.photoCounts(tx, access.tenantId, projectId),
      });
    });
  }

  /**
   * A general photo's metadata-free thumbnail (EXIF and GPS stripped when D6.1 made it); the
   * original upload, which keeps its metadata, is never served to clients.
   */
  async photoImage(principal: Principal, projectId: string, photoId: string, req: Request) {
    const key = await this.scope.run(principal, req, async (scope) => {
      await this.access.project(scope, projectId);
      const row = await scope.tx.sitePhoto.findFirst({
        where: { tenantId: scope.access.tenantId, projectId, id: photoId, purpose: "general" },
        select: { thumbnailKey: true },
      });
      if (!row) throw new NotFoundException("Photo not found");
      return row.thumbnailKey;
    });
    return this.storage.get(key, PHOTO_LIMITS.maxFileBytes);
  }

  diaries(
    principal: Principal,
    projectId: string,
    query: { cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.access.project(scope, projectId);
      const after = query.cursor
        ? await tx.siteDiary.findFirst({
            where: { tenantId: access.tenantId, projectId, id: query.cursor, status: "approved" },
            select: { id: true, date: true },
          })
        : null;
      if (query.cursor && !after) throw new NotFoundException("Diary not found");
      // Approved (locked) diaries only: never drafts, rejections or reviewers.
      const rows = await tx.siteDiary.findMany({
        where: {
          tenantId: access.tenantId,
          projectId,
          status: "approved",
          ...(after
            ? { OR: [{ date: { lt: after.date } }, { date: after.date, id: { lt: after.id } }] }
            : {}),
        },
        include: { site: { select: { name: true } } },
        orderBy: [{ date: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return clientDiariesResponseSchema.parse({
        project: clientProjectRef(project),
        diaries: page.map(diaryWire),
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      });
    });
  }

  // Certificates, statement and paying --------------------------------------------------------

  statement(
    principal: Principal,
    projectId: string,
    override: DisplayCurrency | undefined,
    req: Request,
  ) {
    return this.scope.run(principal, req, (scope) => this.statementOf(scope, projectId, override));
  }

  /**
   * The client statement (also rendered by the PDF and Excel exports): for the project's client,
   * or (`staff`) for the company's valuation and finance readers.
   */
  async statementOf(
    scope: Scope,
    projectId: string,
    override?: DisplayCurrency,
    staff = false,
  ): Promise<ClientStatementResponse> {
    const { tx, access } = scope;
    const project = staff
      ? (await staffProject(scope, projectId, CLIENT_PAYMENT_READ_PERMISSIONS)).project
      : await this.access.project(scope, projectId);
    const ledger = await loadClientLedger(tx, access.tenantId, projectId, project.code);
    const company = await tx.tenant.findUniqueOrThrow({
      where: { id: access.tenantId },
      select: { name: true },
    });
    return clientStatementResponseSchema.parse({
      project: clientProjectRef(project),
      company,
      clientName: project.clientName,
      today: ledger.today,
      paymentTermsDays: ledger.terms.paymentTermsDays,
      certificates: ledger.certificates.map(certificateWire),
      receipts: ledger.payments.map(receiptWire),
      entries: ledger.statement.entries,
      totals: totalsOf(ledger),
      generatedAt: new Date().toISOString(),
      display: await displayFor(tx, access.tenantId, access.userId, override),
    });
  }

  pay(
    principal: Principal,
    projectId: string,
    override: DisplayCurrency | undefined,
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.access.project(scope, projectId);
      const ledger = await loadClientLedger(tx, access.tenantId, projectId, project.code);
      return clientPayResponseSchema.parse({
        project: clientProjectRef(project),
        instructions: instructionsWire(ledger.instructions),
        certificates: ledger.certificates
          .filter((row) => row.outstandingMinor > 0)
          .map(certificateWire),
        totals: totalsOf(ledger),
        stk: {
          available: STK_PUSH_AVAILABLE && this.payments.available,
          reason: STK_PUSH_AVAILABLE && this.payments.available ? null : "provider-not-connected",
        },
        display: await displayFor(tx, access.tenantId, access.userId, override),
      });
    });
  }

  /**
   * Pay with M-Pesa (STK Push) through the `ClientPaymentRequests` boundary (rule D-135): the
   * request is checked against the certificate first (assigned project, certified, something
   * outstanding, no more than that), then handed to the boundary, which refuses with 503
   * stk-push-unavailable until the Daraja provider (D4.2) exists. Nothing here marks anything paid.
   */
  async requestStkPush(
    principal: Principal,
    projectId: string,
    valuationId: string,
    input: ClientStkPushRequest & { phone: string },
    key: string,
    req: Request,
  ) {
    await this.security.limit(
      `client-stk:${principal.user.id}`,
      CLIENT_PORTAL_LIMITS.paymentRequestsPerHour,
      3_600,
    );
    const checked = await this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.access.project(scope, projectId);
      const ledger = await loadClientLedger(tx, access.tenantId, projectId, project.code);
      const certificate = ledger.certificates.find((row) => row.id === valuationId);
      if (!certificate) throw new NotFoundException("Certificate not found");
      if (certificate.outstandingMinor <= 0)
        throw clientPortalProblem(409, "nothing-outstanding", "Nothing is outstanding on it");
      if (!receiptFits(input.amountMinor, certificate.outstandingMinor))
        throw clientPortalProblem(
          422,
          "amount-exceeds-outstanding",
          "The amount is more than is outstanding on this certificate",
        );
      return {
        tenantId: access.tenantId,
        projectId,
        valuationId,
        accountReference: certificate.accountReference ?? project.code,
        amountMinor: input.amountMinor,
        phone: input.phone,
        idempotencyKey: key,
        requestDigest: createHash("sha256")
          .update(JSON.stringify(["client-stk.v1", valuationId, input.amountMinor, input.phone]))
          .digest("hex"),
      };
    });
    return this.payments.request(checked);
  }

  // Variations ----------------------------------------------------------------------------------

  variations(
    principal: Principal,
    projectId: string,
    override: DisplayCurrency | undefined,
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.access.project(scope, projectId);
      const rows = await tx.variationClientRequest.findMany({
        where: { tenantId: access.tenantId, projectId },
        include: { decisions: true, variation: true },
        orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      });
      const people = await peopleOf(
        tx,
        rows.flatMap((row) => row.decisions.map((decision) => decision.decidedBy)),
      );
      return clientVariationsResponseSchema.parse({
        project: clientProjectRef(project),
        approvalRequired: (await this.terms(tx, access.tenantId, projectId)).clientApprovalRequired,
        requests: rows.map((row) => this.requestWire(row, people)),
        display: await displayFor(tx, access.tenantId, access.userId, override),
      });
    });
  }

  variation(
    principal: Principal,
    projectId: string,
    requestId: string,
    override: DisplayCurrency | undefined,
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) =>
      this.variationDetail(scope, projectId, requestId, override),
    );
  }

  /**
   * The client approves or rejects a variation sent to them, once, on the digest of the view they
   * were sent (rule D-134); a rejection needs a comment. The variation itself is unchanged: the
   * contractor's internal approval follows (and waits for this when the project requires it).
   */
  async decide(
    principal: Principal,
    projectId: string,
    requestId: string,
    input: ClientDecisionRequest & { comment?: string },
    req: Request,
  ) {
    await this.security.limit(
      `client-decision:${principal.user.id}`,
      CLIENT_PORTAL_LIMITS.decisionsPerHour,
      3_600,
    );
    try {
      return await this.scope.run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.access.project(scope, projectId);
          const row = await this.requestRow(tx, access.tenantId, projectId, requestId);
          await tx.$queryRaw`SELECT id FROM variation_orders WHERE tenant_id = ${access.tenantId}::uuid
            AND id = ${row.variationId}::uuid FOR SHARE`;
          const fresh = await this.requestRow(tx, access.tenantId, projectId, requestId);
          if (fresh.decisions.length)
            throw clientPortalProblem(409, "already-decided", "You already decided on this");
          if (!this.open(fresh))
            throw clientPortalProblem(
              409,
              "request-closed",
              "The contractor changed or decided this variation after sending it; it can no longer be decided",
            );
          if (input.clientDigest !== fresh.clientDigest)
            throw clientPortalProblem(
              409,
              "variation-stale",
              "These figures are not the ones sent to you. Reload and review them again.",
            );
          const comment = input.comment?.trim() ? input.comment.trim() : null;
          await tx.variationClientDecision.create({
            data: {
              id: uuidv7(),
              tenantId: access.tenantId,
              projectId,
              requestId,
              variationId: fresh.variationId,
              decision: input.decision,
              comment,
              clientDigest: fresh.clientDigest,
              decidedBy: access.userId,
            },
          });
          // The comment is free text, so the audit log records only that one was given.
          await this.scope.audit(tx, "client_portal.variation_decided", requestId, {
            projectId,
            variationId: fresh.variationId,
            decision: input.decision,
            commentGiven: comment !== null,
          });
          return this.variationDetail(scope, projectId, requestId, undefined);
        },
        true,
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw clientPortalProblem(409, "already-decided", "This variation was already decided");
      throw error;
    }
  }

  // Preferences ---------------------------------------------------------------------------------

  preferences(principal: Principal, req: Request) {
    return this.scope.run(principal, req, (scope) => this.preferencesOf(scope));
  }

  updatePreferences(principal: Principal, currency: DisplayCurrency, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        this.access.requireClient(scope);
        await tx.clientPreference.upsert({
          where: { tenantId_userId: { tenantId: access.tenantId, userId: access.userId } },
          create: { tenantId: access.tenantId, userId: access.userId, displayCurrency: currency },
          update: { displayCurrency: currency },
        });
        return this.preferencesOf(scope);
      },
      true,
    );
  }

  // Helpers -------------------------------------------------------------------------------------

  private async preferencesOf(scope: Scope) {
    const { tx, access } = scope;
    this.access.requireClient(scope);
    const row = await tx.clientPreference.findUnique({
      where: { tenantId_userId: { tenantId: access.tenantId, userId: access.userId } },
    });
    return clientPreferencesResponseSchema.parse({
      displayCurrency: row?.displayCurrency ?? "KES",
      rates: await fxRateWire(tx, await latestRates(tx, access.tenantId)),
    });
  }

  private async progressFigures(tx: Tx, tenantId: string, projectId: string, dataDate: string) {
    const inputs = await plannedAndEarned(tx, tenantId, projectId);
    return {
      ...inputs,
      figures: clientProgress({
        bacMinor: inputs.bacMinor,
        evMinor: inputs.ev(dataDate),
        pvMinor: inputs.pv ? inputs.pv.at(dataDate) : null,
      }),
    };
  }

  private async photoCounts(tx: Tx, tenantId: string, projectId: string) {
    const [total, verified] = await Promise.all([
      tx.sitePhoto.count({ where: { tenantId, projectId, purpose: "general" } }),
      tx.sitePhoto.count({ where: { tenantId, projectId, purpose: "general", verified: true } }),
    ]);
    return { total, verified };
  }

  private async terms(tx: Tx, tenantId: string, projectId: string) {
    const row = await tx.projectClientSettings.findFirst({
      where: { tenantId, projectId },
      orderBy: { version: "desc" },
    });
    return { clientApprovalRequired: row?.clientApprovalRequired ?? false };
  }

  private milestoneWire(row: Prisma.MilestoneGetPayload<object>) {
    return {
      id: row.id,
      name: row.name,
      dueDate: toCalendarDate(row.dueDate),
      status: row.status as MilestoneStatus,
      actualDate: row.actualDate ? toCalendarDate(row.actualDate) : null,
    };
  }

  private projectShape(
    row: ClientProjectRow,
    milestones: { status: string }[],
    ledger: Awaited<ReturnType<typeof loadClientLedger>>,
    awaitingDecisions: number,
  ) {
    const project = toProject(row);
    return {
      id: project.id,
      code: project.code,
      name: project.name,
      status: project.status,
      county: project.county,
      town: project.town,
      startDate: project.startDate,
      endDate: project.endDate,
      contractSumMinor: project.contractSumMinor,
      currency: "KES" as const,
      milestones: {
        total: milestones.filter((milestone) => milestone.status !== "cancelled").length,
        achieved: milestones.filter((milestone) => milestone.status === "achieved").length,
      },
      balance: totalsOf(ledger),
      awaitingDecisions,
    };
  }

  private async projectWire(tx: Tx, tenantId: string, row: ClientProjectRow, awaiting: number) {
    const [milestones, ledger] = await Promise.all([
      tx.milestone.findMany({ where: { tenantId, projectId: row.id }, select: { status: true } }),
      loadClientLedger(tx, tenantId, row.id, row.code),
    ]);
    return this.projectShape(row, milestones, ledger, awaiting);
  }

  /** Sendings still waiting for the client's decision, per project. */
  private async awaitingByProject(tx: Tx, tenantId: string, projectIds: string[]) {
    const counts = new Map<string, number>();
    if (!projectIds.length) return counts;
    const rows = await tx.variationClientRequest.findMany({
      where: { tenantId, projectId: { in: projectIds }, decisions: { none: {} } },
      include: { decisions: true, variation: true },
    });
    for (const row of rows)
      if (this.open(row)) counts.set(row.projectId, (counts.get(row.projectId) ?? 0) + 1);
    return counts;
  }

  private open(row: RequestRow): boolean {
    return clientRequestOpen({
      decided: row.decisions.length > 0,
      variation: {
        status: row.variation.status as VariationStatus,
        snapshotDigest: row.variation.snapshotDigest,
        submittedAt: row.variation.submittedAt?.toISOString() ?? null,
      },
      request: { snapshotDigest: row.snapshotDigest, submittedAt: row.submittedAt.toISOString() },
    });
  }

  private requestWire(row: RequestRow, people: Awaited<ReturnType<typeof peopleOf>>) {
    const view = clientVariationViewSchema.parse(row.clientView);
    const decision = row.decisions[0] ?? null;
    return {
      id: row.id,
      number: view.number,
      title: view.title,
      sentAt: row.sentAt.toISOString(),
      message: row.message,
      netMinor: view.totals.netMinor,
      grandTotalEffectMinor: view.grandTotalEffectMinor,
      state: clientRequestState(
        (decision?.decision as ClientDecision | undefined) ?? null,
        this.open(row),
      ),
      outcome: outcomeOf(row.variation.status as VariationStatus),
      decision: decision
        ? clientDecisionSchema.parse({
            decision: decision.decision,
            comment: decision.comment,
            decidedBy: personOf(people, decision.decidedBy),
            decidedAt: decision.decidedAt.toISOString(),
          })
        : null,
    };
  }

  private async requestRow(tx: Tx, tenantId: string, projectId: string, requestId: string) {
    const row = await tx.variationClientRequest.findFirst({
      where: { tenantId, projectId, id: requestId },
      include: { decisions: true, variation: true },
    });
    if (!row) throw new NotFoundException("Variation not found");
    return row;
  }

  private async variationDetail(
    scope: Scope,
    projectId: string,
    requestId: string,
    override: DisplayCurrency | undefined,
  ) {
    const { tx, access } = scope;
    const project = await this.access.project(scope, projectId);
    const row = await this.requestRow(tx, access.tenantId, projectId, requestId);
    const people = await peopleOf(
      tx,
      row.decisions.map((decision) => decision.decidedBy),
    );
    const wire = this.requestWire(row, people);
    return clientVariationDetailResponseSchema.parse({
      project: clientProjectRef(project),
      approvalRequired: (await this.terms(tx, access.tenantId, projectId)).clientApprovalRequired,
      request: {
        ...wire,
        view: clientVariationViewSchema.parse(row.clientView),
        clientDigest: row.clientDigest,
        canDecide:
          wire.state === "awaiting_decision" &&
          project.status !== "closed" &&
          project.status !== "cancelled",
      },
      display: await displayFor(tx, access.tenantId, access.userId, override),
    });
  }
}
