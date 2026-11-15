import { createHash } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";
import { nairobiDate, parseMpesaSms, addCalendarDays } from "@pm-buddy/domain";
import {
  P2P_LIMITS,
  PETTY_CASH_READ_PERMISSIONS,
  SPENDING_LIMITS,
  SPENDING_READ_PERMISSIONS,
  type CostCategory,
  type ExpenseStatus,
} from "@pm-buddy/types";
import {
  expenseResponseSchema,
  expensesResponseSchema,
  receiptResponseSchema,
  smsParseResponseSchema,
  type ParsedExpenseRequest,
} from "@pm-buddy/validation";
import { describeError } from "../../common/errors.js";
import { isUniqueViolation } from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { MalwareDetected, MalwareScanner } from "../../infra/malware-scanner.js";
import { StorageService } from "../../infra/storage.service.js";
import type { Scope } from "../identity/access-policy.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { nextId } from "../procurement/catalogue-store.js";
import { requestDigest } from "../procurement/p2p/p2p-common.js";
import { sniffDocument } from "../procurement/p2p/p2p-documents.service.js";
import { peopleOf, personOf, toCalendarDate } from "../procurement/procurement-mappers.js";
import { PettyCashService } from "./petty-cash.service.js";
import {
  approvedBqVersion,
  bqItemRefs,
  costCodeRefs,
  databaseMessage,
  itemKey,
  makerChecker,
  minorOf,
  nextSpendingNumber,
  projectRef,
  SpendingAccess,
  spendingConflict,
  spendingDatabaseProblem,
  spendingInvalidTransition,
  spendingProblem,
  spendingVersionConflict,
  supplierNames,
} from "./spending-common.js";

type ExpenseRow = Prisma.PettyCashExpenseGetPayload<object>;
type ReceiptRow = Prisma.PettyCashReceiptGetPayload<object>;
export type UploadedReceipt = { buffer: Buffer; originalname: string; size: number };

/**
 * Before a multipart body is read: refuse an oversized declared length (413), require a session
 * (401) and rate-limit uploads per user (429), as for GRN photos.
 */
@Injectable()
export class ReceiptUploadGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (Number(req.headers["content-length"] ?? 0) > P2P_LIMITS.imageMaxBytes + 64 * 1024)
      throw new PayloadTooLargeException({
        message: "Receipt photos may be at most 5 MB",
        code: "payload-too-large",
      });
    const principal = await this.auth.principal(req);
    await this.security.limit(
      `receipt-upload:${principal.user.id}`,
      P2P_LIMITS.uploadsPerHour,
      3_600,
    );
    return true;
  }
}

/**
 * Petty-cash expenses (D5.4, brief §5.8): recorded by the float's custodian, offline-ready (the
 * client chooses the ID and sends an `Idempotency-Key`; a replay returns the original, a changed
 * payload is 409 idempotency-key-reused), tagged like every cost (category, BQ item or cost code,
 * counterparty, M-Pesa code). The cash leaves the float when the expense is recorded (never below
 * zero; the float row is locked); approval by an independent `finance.manage` or
 * `procurement.approve` holder needs a receipt photo and posts the cost (accrued and paid; an
 * M-Pesa charge as fees); rejection puts the cash back on the book (the custodian owes it). One
 * M-Pesa code is one expense. A pasted SMS only fills a DRAFT: it never confirms settlement.
 */
@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name);

  constructor(
    private readonly scope: TenantScope,
    private readonly access: SpendingAccess,
    private readonly floats: PettyCashService,
    private readonly storage: StorageService,
    private readonly scanner: MalwareScanner,
  ) {}

  list(
    principal: Principal,
    query: {
      floatId?: string;
      projectId?: string;
      status?: ExpenseStatus;
      cursor?: string;
      limit: number;
    },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const projectIds = await this.access.projectIds(
        scope,
        PETTY_CASH_READ_PERMISSIONS,
        query.projectId,
      );
      const after = query.cursor
        ? await tx.pettyCashExpense.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: query.cursor } },
            select: { id: true, recordedAt: true },
          })
        : null;
      // Client-chosen IDs are not time-ordered: page by (recorded at, id), newest first.
      const rows = await tx.pettyCashExpense.findMany({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          ...(query.floatId ? { floatId: query.floatId } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(after
            ? {
                OR: [
                  { recordedAt: { lt: after.recordedAt } },
                  { recordedAt: after.recordedAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return expensesResponseSchema.parse({
        expenses: await this.wire(scope, page),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
      });
    });
  }

  get(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const row = await this.row(scope, id);
      await this.access.pettyCashReader(scope, row.projectId);
      return this.response(scope, row, false);
    });
  }

  record(principal: Principal, input: ParsedExpenseRequest, key: string, req: Request) {
    const digest = requestDigest("petty_cash.expense", input);
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const replay = await tx.pettyCashExpense.findUnique({
            where: { tenantId_idempotencyKey: { tenantId: access.tenantId, idempotencyKey: key } },
          });
          if (replay) {
            if (replay.requestDigest !== digest || replay.id !== input.id)
              throw spendingConflict(
                "idempotency-key-reused",
                "This idempotency key was used for a different expense",
              );
            await this.access.pettyCashReader(scope, replay.projectId);
            return this.response(scope, replay, true);
          }
          const clash = await tx.pettyCashExpense.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: input.id } },
          });
          if (clash)
            throw spendingConflict(
              "expense-id-conflict",
              "An expense with this ID was sent with another key",
            );
          // Lock the float first: concurrent spends from one float are serialised.
          await tx.$queryRaw`SELECT id FROM petty_cash_floats
            WHERE tenant_id = ${access.tenantId}::uuid AND id = ${input.floatId}::uuid FOR UPDATE`;
          const float = await this.floats.floatRow(scope, input.floatId);
          const project = await this.access.pettyCashReader(scope, float.projectId);
          this.access.writable(project);
          if (float.status !== "active")
            throw spendingConflict("float-closed", "This float is closed");
          if (
            float.custodianUserId !== access.userId ||
            !project.permissions.has("finance.petty_cash")
          )
            throw spendingProblem(
              403,
              "not-custodian",
              "Only the float's custodian records its expenses",
            );
          const today = nairobiDate();
          if (
            input.spentOn > today ||
            input.spentOn < addCalendarDays(today, -SPENDING_LIMITS.expenseMaxAgeDays)
          )
            throw spendingProblem(
              400,
              "expense-date-invalid",
              `An expense is dated within the last ${SPENDING_LIMITS.expenseMaxAgeDays} days`,
            );
          let bq: { versionId: string; lineageId: string } | null = null;
          if (input.bqItemLineageId) {
            const version = await approvedBqVersion(tx, access.tenantId, float.projectId);
            if (!version)
              throw spendingConflict("bq-not-approved", "The project has no approved BQ yet");
            const item = await tx.bqItem.findUnique({
              where: {
                tenantId_versionId_lineageId: {
                  tenantId: access.tenantId,
                  versionId: version.id,
                  lineageId: input.bqItemLineageId,
                },
              },
            });
            if (!item)
              throw spendingProblem(422, "bq-item-not-found", "The item is not in the BQ in force");
            bq = { versionId: version.id, lineageId: item.lineageId };
          }
          if (input.costCodeId) {
            const code = await tx.costCode.findUnique({
              where: { tenantId_id: { tenantId: access.tenantId, id: input.costCodeId } },
            });
            if (!code) throw spendingProblem(422, "cost-code-not-found", "Cost code not found");
            if (!code.active)
              throw spendingConflict("cost-code-inactive", "This cost code is inactive");
          }
          if (input.supplierId) {
            const supplier = await tx.supplier.findUnique({
              where: { tenantId_id: { tenantId: access.tenantId, id: input.supplierId } },
            });
            if (!supplier) throw spendingProblem(422, "supplier-not-found", "Supplier not found");
          }
          if (input.mpesaCode) {
            const used = await tx.pettyCashExpense.findFirst({
              where: {
                tenantId: access.tenantId,
                mpesaCode: input.mpesaCode,
                status: { not: "rejected" },
              },
              select: { number: true },
            });
            if (used)
              throw spendingConflict(
                "mpesa-code-duplicate",
                `This M-Pesa transaction is already recorded as ${used.number}`,
              );
          }
          const total = BigInt(input.amountMinor) + BigInt(input.chargeMinor);
          if (total > float.balanceMinor)
            throw spendingConflict(
              "float-insufficient",
              "The float does not hold enough cash for this expense",
            );
          const row = await tx.pettyCashExpense.create({
            data: {
              id: input.id,
              tenantId: access.tenantId,
              projectId: float.projectId,
              floatId: float.id,
              siteId: float.siteId,
              number: await nextSpendingNumber(tx, access.tenantId, "expense"),
              spentOn: new Date(`${input.spentOn}T00:00:00.000Z`),
              amountMinor: BigInt(input.amountMinor),
              chargeMinor: BigInt(input.chargeMinor),
              category: input.category,
              costCodeId: input.costCodeId ?? null,
              bqVersionId: bq?.versionId ?? null,
              bqItemLineageId: bq?.lineageId ?? null,
              counterpartyKind: input.counterpartyKind,
              supplierId: input.supplierId ?? null,
              payeeName: input.payeeName,
              payeeAccount: input.payeeAccount ?? null,
              payeePhoneMasked: input.payeePhoneMasked ?? null,
              paymentMethod: input.paymentMethod,
              mpesaCode: input.mpesaCode ?? null,
              parsedFromSms: input.parsedFromSms,
              smsKind: input.smsKind ?? null,
              description: input.description,
              idempotencyKey: key,
              requestDigest: digest,
              capturedAt: new Date(input.capturedAt),
              source: input.source,
              recordedBy: access.userId,
            },
          });
          await tx.pettyCashEntry.create({
            data: {
              id: nextId(),
              tenantId: access.tenantId,
              floatId: float.id,
              seq: 0n,
              kind: "expense",
              amountMinor: -total,
              balanceMinor: 0n,
              expenseId: row.id,
              recordedBy: access.userId,
              businessDate: new Date(),
            },
          });
          // No amounts, payees or codes in the audit log.
          await this.scope.audit(tx, "petty_cash.expense_recorded", row.id, {
            floatId: float.id,
            category: input.category,
            method: input.paymentMethod,
            fromSms: input.parsedFromSms,
            source: input.source,
          });
          return this.response(scope, row, false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          if (databaseMessage(error).includes("mpesa_code"))
            throw spendingConflict(
              "mpesa-code-duplicate",
              "This M-Pesa transaction is already recorded",
            );
          throw spendingConflict(
            "expense-id-conflict",
            "This expense was recorded by another request",
          );
        }
        throw spendingDatabaseProblem(error) ?? error;
      });
  }

  decide(
    principal: Principal,
    id: string,
    action: "approve" | "reject",
    input: { version: number; reason?: string },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          const project = await this.access.pettyCashReader(scope, row.projectId);
          if (!this.access.canApprovePettyCash(project))
            throw new ForbiddenException(
              "Approving petty cash needs finance.manage or procurement.approve",
            );
          if (row.status !== "submitted") throw spendingInvalidTransition(row.status);
          if (row.version !== input.version) throw spendingVersionConflict();
          const float = await this.floats.floatRow(scope, row.floatId);
          if (access.userId === row.recordedBy || access.userId === float.custodianUserId)
            throw makerChecker("The custodian cannot decide their own expenses");
          if (action === "approve") {
            const receipts = await tx.pettyCashReceipt.count({
              where: { tenantId: access.tenantId, expenseId: id },
            });
            if (!receipts)
              throw spendingConflict("receipt-required", "Add a receipt photo before approving");
          }
          await tx.pettyCashExpense.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              status: action === "approve" ? "approved" : "rejected",
              decidedBy: access.userId,
              decidedAt: new Date(),
              decisionReason: action === "reject" ? input.reason : null,
              version: { increment: 1 },
            },
          });
          if (action === "reject")
            await tx.pettyCashEntry.create({
              data: {
                id: nextId(),
                tenantId: access.tenantId,
                floatId: row.floatId,
                seq: 0n,
                kind: "expense_rejected",
                amountMinor: row.amountMinor + row.chargeMinor,
                balanceMinor: 0n,
                expenseId: id,
                recordedBy: access.userId,
                businessDate: new Date(),
              },
            });
          else await this.post(scope, row);
          await this.scope.audit(
            tx,
            `petty_cash.expense_${action === "approve" ? "approved" : "rejected"}`,
            id,
            {
              floatId: row.floatId,
              ...(action === "reject" ? { reasonGiven: true } : {}),
            },
          );
          return this.response(scope, await this.row(scope, id), false);
        },
        true,
      )
      .catch((error: unknown) => {
        throw spendingDatabaseProblem(error) ?? error;
      });
  }

  /** The approved expense's cost: accrued and paid, and its M-Pesa charge as fees. */
  private async post(scope: Scope, row: ExpenseRow) {
    const { tx, access } = scope;
    const tags = {
      tenantId: access.tenantId,
      projectId: row.projectId,
      siteId: row.siteId,
      costCodeId: row.costCodeId,
      bqVersionId: row.bqVersionId,
      bqItemLineageId: row.bqItemLineageId,
      counterpartyKind: row.counterpartyKind,
      supplierId: row.supplierId,
      counterpartyName: row.payeeName,
      paymentReference: row.mpesaCode,
      occurredOn: row.spentOn,
      source: "petty_cash_expense",
      expenseId: row.id,
      recordedBy: access.userId,
      businessDate: new Date(),
    };
    const postings: [string, "accrued" | "paid", CostCategory, bigint][] = [
      ["accrual", "accrued", row.category as CostCategory, row.amountMinor],
      ["payment", "paid", row.category as CostCategory, row.amountMinor],
    ];
    if (row.chargeMinor > 0n)
      postings.push(
        ["charge_accrual", "accrued", "fees", row.chargeMinor],
        ["charge_payment", "paid", "fees", row.chargeMinor],
      );
    for (const [purpose, measure, category, amount] of postings)
      await tx.costEntry.create({
        data: { ...tags, id: nextId(), purpose, measure, category, amountMinor: amount },
      });
  }

  // Receipts ----------------------------------------------------------------------------------

  /** Adds a receipt photo (JPEG, PNG or WebP; content sniffed; malware hook; private storage). */
  async addReceipt(
    principal: Principal,
    id: string,
    file: UploadedReceipt | undefined,
    req: Request,
  ) {
    if (!file?.buffer?.length)
      throw new BadRequestException({
        code: "file-required",
        message: "Attach the photo as `file`",
      });
    const authorise = async (scope: Scope) => {
      const row = await this.row(scope, id);
      const project = await this.access.pettyCashReader(scope, row.projectId);
      this.access.writable(project);
      if (row.recordedBy !== scope.access.userId && !project.permissions.has("finance.manage"))
        throw new ForbiddenException("Only the custodian or finance adds receipts");
      if (row.status === "rejected") throw spendingInvalidTransition(row.status);
      const count = await scope.tx.pettyCashReceipt.count({
        where: { tenantId: scope.access.tenantId, expenseId: id },
      });
      if (count >= SPENDING_LIMITS.receiptsPerExpense)
        throw spendingConflict("too-many-receipts", "An expense keeps at most three receipts");
      return row.projectId;
    };
    const projectId = await this.scope.run(principal, req, authorise);
    const contentType = sniffDocument(file.buffer);
    if (!contentType || contentType === "application/pdf")
      throw spendingProblem(
        415,
        "unsupported-file-type",
        "Receipts must be JPEG, PNG or WebP photos",
      );
    if (file.buffer.length > P2P_LIMITS.imageMaxBytes)
      throw spendingProblem(413, "payload-too-large", "The photo is too large");
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    let scan;
    try {
      scan = await this.scanner.scan(file.buffer, { sha256 });
    } catch (error) {
      if (error instanceof MalwareDetected)
        throw spendingProblem(
          422,
          "malware-detected",
          "The file was refused by the malware scanner",
        );
      throw error;
    }
    const receiptId = nextId();
    const tenantId = principal.session.activeTenantId!;
    const objectKey = `tenants/${tenantId}/projects/${projectId}/petty-cash/receipts/${receiptId}`;
    await this.storage.put(objectKey, file.buffer, contentType, sha256);
    try {
      return await this.scope.run(
        principal,
        req,
        async (scope) => {
          await authorise(scope);
          const row = await scope.tx.pettyCashReceipt.create({
            data: {
              id: receiptId,
              tenantId: scope.access.tenantId,
              projectId,
              expenseId: id,
              objectKey,
              contentType,
              sizeBytes: file.buffer.length,
              sha256,
              scanStatus: scan.status,
              scanEngine: scan.engine,
              scannedAt: scan.scannedAt,
              uploadedBy: scope.access.userId,
            },
          });
          await this.scope.audit(scope.tx, "petty_cash.receipt_added", id, {
            receiptId,
            contentType,
            sizeBytes: file.buffer.length,
            scan: scan.status,
          });
          return receiptResponseSchema.parse({
            receipt: toReceipt(row, await peopleOf(scope.tx, [row.uploadedBy])),
          });
        },
        true,
      );
    } catch (error) {
      await this.storage
        .delete(objectKey)
        .catch((cleanup: unknown) =>
          this.logger.warn(`Could not remove an orphaned receipt: ${describeError(cleanup)}`),
        );
      throw error;
    }
  }

  async receipt(principal: Principal, id: string, req: Request) {
    const row = await this.scope.run(principal, req, async (scope) => {
      const receipt = await scope.tx.pettyCashReceipt.findUnique({
        where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
      });
      if (!receipt) throw new NotFoundException("Receipt not found");
      await this.access.pettyCashReader(scope, receipt.projectId);
      return receipt;
    });
    const content = await this.storage.get(row.objectKey, P2P_LIMITS.imageMaxBytes);
    if (createHash("sha256").update(content).digest("hex") !== row.sha256)
      throw spendingConflict("invalid-transition", "The stored file does not match its checksum");
    return {
      content,
      contentType: row.contentType,
      fileName: `receipt-${row.id}.${row.contentType.split("/")[1]}`,
    };
  }

  // SMS ---------------------------------------------------------------------------------------

  /**
   * Parses a pasted M-Pesa SMS into a draft (packages/domain parseMpesaSms) and lists records that
   * already hold its transaction code. Never stores the text and never confirms settlement.
   */
  parseSms(principal: Principal, text: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const pettyCash = await this.access.projectIds(scope, PETTY_CASH_READ_PERMISSIONS);
      if (!pettyCash.length) throw new ForbiddenException("No petty-cash permission");
      const result = parseMpesaSms(text);
      const duplicates: {
        kind: "expense" | "settlement" | "top_up";
        id: string;
        label: string;
        status: string;
      }[] = [];
      if (result.ok) {
        const code = result.draft.code;
        const [expenses, topUps] = await Promise.all([
          tx.pettyCashExpense.findMany({
            where: { tenantId: access.tenantId, mpesaCode: code, projectId: { in: pettyCash } },
            select: { id: true, number: true, status: true },
          }),
          tx.pettyCashTopUp.findMany({
            where: { tenantId: access.tenantId, referenceKey: code, projectId: { in: pettyCash } },
            select: { id: true, number: true, status: true },
          }),
        ]);
        const finance = await this.access.projectIds(scope, SPENDING_READ_PERMISSIONS);
        const settlements = finance.length
          ? await tx.invoiceSettlement.findMany({
              where: {
                tenantId: access.tenantId,
                referenceKey: code,
                payable: { invoice: { projectId: { in: finance } } },
              },
              select: {
                id: true,
                payable: { select: { invoice: { select: { invoiceNumber: true } } } },
              },
            })
          : [];
        for (const row of expenses)
          duplicates.push({ kind: "expense", id: row.id, label: row.number, status: row.status });
        for (const row of topUps)
          duplicates.push({ kind: "top_up", id: row.id, label: row.number, status: row.status });
        for (const row of settlements)
          duplicates.push({
            kind: "settlement",
            id: row.id,
            label: row.payable.invoice.invoiceNumber,
            status: "recorded",
          });
      }
      return smsParseResponseSchema.parse({ result, duplicates, confirmsSettlement: false });
    });
  }

  // Helpers -----------------------------------------------------------------------------------

  async row(scope: Scope, id: string): Promise<ExpenseRow> {
    const row = await scope.tx.pettyCashExpense.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Expense not found");
    return row;
  }

  async response(scope: Scope, row: ExpenseRow, replayed: boolean) {
    const { tx, access } = scope;
    const [expense] = await this.wire(scope, [row]);
    const receipts = await tx.pettyCashReceipt.findMany({
      where: { tenantId: access.tenantId, expenseId: row.id },
      orderBy: { uploadedAt: "asc" },
    });
    const people = await peopleOf(
      tx,
      receipts.map((receipt) => receipt.uploadedBy),
    );
    const project = await this.access.on(scope, row.projectId);
    const float = await this.floats.floatRow(scope, row.floatId);
    const independent = access.userId !== row.recordedBy && access.userId !== float.custodianUserId;
    const submitted = row.status === "submitted";
    return expenseResponseSchema.parse({
      expense: { ...expense!, receipts: receipts.map((receipt) => toReceipt(receipt, people)) },
      replayed,
      permissions: {
        canApprove:
          this.access.canApprovePettyCash(project) &&
          submitted &&
          independent &&
          receipts.length > 0,
        canReject: this.access.canApprovePettyCash(project) && submitted && independent,
        canAddReceipt:
          this.access.isWritable(project) &&
          row.status !== "rejected" &&
          receipts.length < SPENDING_LIMITS.receiptsPerExpense &&
          (row.recordedBy === access.userId || project.permissions.has("finance.manage")),
      },
    });
  }

  async wire(scope: Scope, rows: ExpenseRow[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const [floats, projects, sites, codes, items, suppliers, people, receipts] = await Promise.all([
      tx.pettyCashFloat.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.floatId) } },
        select: { id: true, name: true },
      }),
      tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.projectId) } },
        select: { id: true, code: true, name: true },
      }),
      tx.site.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.siteId) } },
        select: { id: true, name: true },
      }),
      costCodeRefs(
        tx,
        access.tenantId,
        rows.map((row) => row.costCodeId),
      ),
      bqItemRefs(
        tx,
        access.tenantId,
        rows.map((row) =>
          row.bqVersionId && row.bqItemLineageId
            ? { versionId: row.bqVersionId, lineageId: row.bqItemLineageId }
            : null,
        ),
      ),
      supplierNames(
        tx,
        access.tenantId,
        rows.map((row) => row.supplierId),
      ),
      peopleOf(
        tx,
        rows.flatMap((row) => [row.recordedBy, row.decidedBy]),
      ),
      tx.pettyCashReceipt.groupBy({
        by: ["expenseId"],
        where: { tenantId: access.tenantId, expenseId: { in: rows.map((row) => row.id) } },
        _count: true,
      }),
    ]);
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      float: floats.find((float) => float.id === row.floatId)!,
      project: projectRef(projects.find((project) => project.id === row.projectId)!),
      site: sites.find((site) => site.id === row.siteId)!,
      spentOn: toCalendarDate(row.spentOn),
      amountMinor: minorOf(row.amountMinor),
      chargeMinor: minorOf(row.chargeMinor),
      category: row.category as CostCategory,
      costCode: row.costCodeId ? (codes.get(row.costCodeId) ?? null) : null,
      bqItem: items.get(itemKey(row.bqVersionId, row.bqItemLineageId) ?? "") ?? null,
      counterpartyKind: row.counterpartyKind as "supplier" | "worker" | "other",
      supplier: row.supplierId
        ? { id: row.supplierId, name: suppliers.get(row.supplierId) ?? "—" }
        : null,
      payeeName: row.payeeName,
      payeeAccount: row.payeeAccount,
      payeePhoneMasked: row.payeePhoneMasked,
      paymentMethod: row.paymentMethod as "cash" | "mpesa",
      mpesaCode: row.mpesaCode,
      parsedFromSms: row.parsedFromSms,
      smsKind: row.smsKind as never,
      description: row.description,
      status: row.status as ExpenseStatus,
      source: row.source as "web" | "site_app",
      capturedAt: row.capturedAt.toISOString(),
      recordedAt: row.recordedAt.toISOString(),
      recordedBy: personOf(people, row.recordedBy),
      decidedBy: row.decidedBy ? personOf(people, row.decidedBy) : null,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionReason: row.decisionReason,
      receiptCount: receipts.find((entry) => entry.expenseId === row.id)?._count ?? 0,
      version: row.version,
    }));
  }
}

const toReceipt = (row: ReceiptRow, people: Map<string, string> | ReadonlyMap<string, string>) => ({
  id: row.id,
  contentType: row.contentType as "image/jpeg" | "image/png" | "image/webp",
  sizeBytes: row.sizeBytes,
  scanStatus: row.scanStatus as "clean" | "not_scanned",
  uploadedAt: row.uploadedAt.toISOString(),
  uploadedBy: personOf(people, row.uploadedBy),
});
