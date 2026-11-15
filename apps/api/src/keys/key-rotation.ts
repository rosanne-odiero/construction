import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import type { FieldCipher } from "../modules/labour/field-cipher.js";
import type { SealedSecrets } from "../modules/identity/sealed-secrets.js";

/**
 * Key rotation for stored ciphertexts (D9.1, D-151, docs/OPERATIONS.md "Key rotation"). Moves
 * values written under an older key version to the active one:
 * - field ciphertexts (FIELD_ENCRYPTION_KEYS): decrypted and re-encrypted with the same associated
 *   data (company, table, column, row), company by company in that company's RLS context;
 * - sealed TOTP seeds (AUTH_MFA_ENCRYPTION_KEY): users.mfa_secret and users.mfa_pending.
 * Safe to stop and run again: only values on another key version are selected, every batch is one
 * transaction, and each update is compare-and-swap on the old value, so a value the application
 * changed meanwhile is left alone. Runs as the schema owner; the database lets the owner rewrite
 * a ciphertext and nothing else on append-only or immutable rows (migrations 20261202090000
 * and, for payments, 20261204093000).
 * Every run is recorded in key_rotation_runs. Plaintext never leaves this process and is never
 * logged; failures name the table, column and row only.
 */
export type FieldColumn = {
  table: string;
  column: string;
  /**
   * The column naming the row in the ciphertext's associated data (and for paging): `id`, or
   * `tenant_id` for a table with one row per company (payment settings).
   */
  rowKey: "id" | "tenant_id";
};
const each = (table: string, columns: string[], rowKey: FieldColumn["rowKey"] = "id") =>
  columns.map((column): FieldColumn => ({ table, column, rowKey }));
export const FIELD_COLUMNS: readonly FieldColumn[] = [
  ...each("labourers", [
    "id_number_enc",
    "phone_enc",
    "kra_pin_enc",
    "nssf_number_enc",
    "sha_number_enc",
    "next_of_kin_enc",
  ]),
  ...each("do_not_rehire_events", ["reason_enc"]),
  ...each("suppliers", ["kra_pin_enc"]),
  ...each("supplier_contacts", ["phone_enc"]),
  ...each("supplier_payout_versions", ["account_number_enc"]),
  // D4.2 payments (migration 20261204093000_payments_key_rotation lets the owner rewrap them).
  ...each(
    "payment_settings",
    [
      "consumer_key_enc",
      "consumer_secret_enc",
      "initiator_name_enc",
      "initiator_password_enc",
      "passkey_enc",
    ],
    "tenant_id",
  ),
  ...each("payment_callback_routes", ["token_enc"]),
  ...each("payment_requests", ["msisdn_enc"]),
  ...each("payment_callback_inbox", ["body_enc"]),
];

/** users columns sealed with AUTH_MFA_ENCRYPTION_KEY (TOTP seeds, sealed for `totp:<user ID>`). */
const MFA_COLUMNS = ["mfa_secret", "mfa_pending"] as const;
const totpPurpose = (userId: string) => `totp:${userId}`;

const FIRST_ID = "00000000-0000-0000-0000-000000000000";
const MAX_FAILURES_LISTED = 50;

export type RewrapOptions = {
  operator: string;
  tenantId?: string;
  batchSize?: number;
  dryRun?: boolean;
};

export type ColumnResult = {
  table: string;
  column: string;
  checked: number;
  rewrapped: number;
  failed: number;
};

export type RunSummary = {
  runId: string;
  kind: "field" | "mfa";
  targetVersion: number;
  dryRun: boolean;
  status: "completed" | "completed_with_errors" | "failed";
  /** Values found on another key version. */
  checked: number;
  rewrapped: number;
  failed: number;
  columns: ColumnResult[];
  /** Row references (never values) that could not be read, for investigation. */
  failures: string[];
};

export type VersionCounts = Record<string, Record<string, number>>;

type Tx = Prisma.TransactionClient;
type Row = { id: string; value: Uint8Array };
type SealedRow = { id: string; mfa_secret: string | null; mfa_pending: string | null };

export class KeyRotation {
  constructor(
    private readonly db: PrismaClient,
    private readonly keys: { field?: FieldCipher; sealed?: SealedSecrets },
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Refuses to run as anyone but the owner of the tables (never pmb_app). */
  async assertOwner(): Promise<void> {
    const [row] = await this.db.$queryRaw<{ role: string; owner: string | null }[]>`
      SELECT current_user::text AS role,
             (SELECT tableowner::text FROM pg_tables
               WHERE schemaname = 'public' AND tablename = 'labourers') AS owner`;
    if (!row || row.owner !== row.role)
      throw new Error(
        `keys:rotate must connect as the schema owner (DATABASE_MIGRATION_URL), not as ${row?.role ?? "an unknown role"}`,
      );
  }

  async tenants(only?: string): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT tenant_id::text AS id FROM tenants ORDER BY tenant_id`;
    const ids = rows.map((row) => row.id);
    if (only === undefined) return ids;
    if (!ids.includes(only)) throw new Error(`No company with ID ${only}`);
    return [only];
  }

  private inTenant<T>(tenantId: string | null, operation: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId ?? ""}, true),
          set_config('app.user_id', '', true), set_config('app.request_id', 'key-rotation', true)`;
        return operation(tx);
      },
      { timeout: 60_000 },
    );
  }

  /** Field ciphertexts per table.column and key version, for the whole database or one company. */
  async fieldStatus(only?: string): Promise<VersionCounts> {
    const counts: VersionCounts = {};
    for (const tenantId of await this.tenants(only))
      await this.inTenant(tenantId, async (tx) => {
        for (const { table, column } of FIELD_COLUMNS) {
          const rows = await tx.$queryRaw<{ version: number; count: bigint }[]>(Prisma.sql`
            SELECT get_byte(${Prisma.raw(column)}, 1) AS version, count(*) AS count
              FROM ${Prisma.raw(table)}
             WHERE tenant_id = ${tenantId}::uuid AND ${Prisma.raw(column)} IS NOT NULL
             GROUP BY 1`);
          const entry = (counts[`${table}.${column}`] ??= {});
          for (const row of rows)
            entry[`v${row.version}`] = (entry[`v${row.version}`] ?? 0) + Number(row.count);
        }
      });
    return counts;
  }

  /** Sealed TOTP seeds per key version (`unreadable` for a malformed value). */
  async mfaStatus(only?: string): Promise<VersionCounts> {
    const counts: VersionCounts = {};
    const sealed = this.sealedKeys();
    await this.forEachUserBatch(only, 1000, async (_tx, users) => {
      for (const user of users)
        for (const column of MFA_COLUMNS) {
          const value = user[column];
          if (!value) continue;
          let version = "unreadable";
          try {
            version = `v${sealed.versionOf(value)}`;
          } catch {
            // counted as unreadable
          }
          const entry = (counts[`users.${column}`] ??= {});
          entry[version] = (entry[version] ?? 0) + 1;
        }
    });
    return counts;
  }

  /** Labourer PINs per pepper version (`none` = stored before the pepper). Re-hashed at sign-in. */
  async pinStatus(): Promise<Record<string, number>> {
    const rows = await this.db.$queryRaw<{ version: number | null; count: bigint }[]>`
      SELECT pin_pepper_version AS version, count(*) AS count FROM users
       WHERE pin_hash IS NOT NULL GROUP BY 1 ORDER BY 1`;
    return Object.fromEntries(
      rows.map((row) => [row.version === null ? "none" : `v${row.version}`, Number(row.count)]),
    );
  }

  /** Re-encrypts every field ciphertext that is not on the active key version. */
  async rewrapFields(options: RewrapOptions): Promise<RunSummary> {
    const cipher = this.keys.field;
    if (!cipher) throw new Error("FIELD_ENCRYPTION_KEYS is not configured");
    const target = cipher.activeVersion;
    const batch = options.batchSize ?? 200;
    return this.recorded("field", target, options, async (summary) => {
      for (const tenantId of await this.tenants(options.tenantId))
        for (const spec of FIELD_COLUMNS) {
          const result = columnResult(summary, spec.table, spec.column);
          const before = { ...result };
          let after = FIRST_ID;
          for (;;) {
            const key = Prisma.raw(spec.rowKey);
            const rows = await this.inTenant(tenantId, async (tx) => {
              const found = await tx.$queryRaw<Row[]>(Prisma.sql`
                SELECT ${key}::text AS id, ${Prisma.raw(spec.column)} AS value
                  FROM ${Prisma.raw(spec.table)}
                 WHERE tenant_id = ${tenantId}::uuid AND ${Prisma.raw(spec.column)} IS NOT NULL
                   AND get_byte(${Prisma.raw(spec.column)}, 1) <> ${target}
                   AND ${key} > ${after}::uuid
                 ORDER BY ${key} LIMIT ${batch}`);
              for (const row of found) {
                result.checked += 1;
                const context = { tenantId, table: spec.table, column: spec.column, rowId: row.id };
                let next: Uint8Array;
                try {
                  next = cipher.reencrypt(context, row.value);
                } catch {
                  fail(summary, result, `${spec.table}.${spec.column} ${tenantId}/${row.id}`);
                  continue;
                }
                if (options.dryRun) continue;
                result.rewrapped += await tx.$executeRaw(Prisma.sql`
                  UPDATE ${Prisma.raw(spec.table)} SET ${Prisma.raw(spec.column)} = ${next}
                   WHERE tenant_id = ${tenantId}::uuid AND ${key} = ${row.id}::uuid
                     AND ${Prisma.raw(spec.column)} = ${row.value}`);
              }
              return found;
            });
            if (rows.length) after = rows[rows.length - 1]!.id;
            if (rows.length < batch) break;
          }
          if (result.checked > before.checked)
            this.log(
              `${tenantId} ${spec.table}.${spec.column}: ${result.checked - before.checked} on an older key, ` +
                `${result.rewrapped - before.rewrapped} re-encrypted, ${result.failed - before.failed} unreadable`,
            );
        }
    });
  }

  /** Re-seals TOTP seeds (and pending enrolments) that are not on the active key version. */
  async rewrapMfa(options: RewrapOptions): Promise<RunSummary> {
    const sealed = this.sealedKeys();
    const target = sealed.activeVersion;
    return this.recorded("mfa", target, options, async (summary) => {
      await this.forEachUserBatch(options.tenantId, options.batchSize ?? 200, async (tx, users) => {
        for (const user of users)
          for (const column of MFA_COLUMNS) {
            const value = user[column];
            if (!value) continue;
            const result = columnResult(summary, "users", column);
            let stale: boolean;
            try {
              stale = sealed.needsRewrap(value);
            } catch {
              result.checked += 1;
              fail(summary, result, `users.${column} ${user.id}`);
              continue;
            }
            if (!stale) continue;
            result.checked += 1;
            let next: string;
            try {
              next = await sealed.rewrap(value, totpPurpose(user.id));
            } catch {
              fail(summary, result, `users.${column} ${user.id}`);
              continue;
            }
            if (options.dryRun) continue;
            result.rewrapped +=
              column === "mfa_secret"
                ? await tx.$executeRaw`UPDATE users SET mfa_secret = ${next}
                    WHERE id = ${user.id}::uuid AND mfa_secret = ${value}`
                : await tx.$executeRaw`UPDATE users SET mfa_pending = ${next}
                    WHERE id = ${user.id}::uuid AND mfa_pending = ${value}`;
          }
      });
      this.log(
        `users: ${summary.columns.reduce((sum, c) => sum + c.rewrapped, 0)} sealed values re-encrypted, ${summary.failed} unreadable`,
      );
    });
  }

  private sealedKeys(): SealedSecrets {
    if (!this.keys.sealed) throw new Error("AUTH_MFA_ENCRYPTION_KEY is not configured");
    return this.keys.sealed;
  }

  /** Users with a sealed value, in batches; with a company, only that company's members. */
  private async forEachUserBatch(
    tenantId: string | undefined,
    batch: number,
    visit: (tx: Tx, users: SealedRow[]) => Promise<void>,
  ): Promise<void> {
    if (tenantId !== undefined) await this.tenants(tenantId);
    let after = FIRST_ID;
    for (;;) {
      const users = await this.inTenant(tenantId ?? null, async (tx) => {
        const members =
          tenantId === undefined
            ? Prisma.empty
            : Prisma.sql`AND EXISTS (SELECT 1 FROM memberships m
                WHERE m.user_id = u.id AND m.tenant_id = ${tenantId}::uuid)`;
        const found = await tx.$queryRaw<SealedRow[]>(Prisma.sql`
          SELECT id::text AS id, mfa_secret, mfa_pending FROM users u
           WHERE (mfa_secret IS NOT NULL OR mfa_pending IS NOT NULL) AND id > ${after}::uuid
             ${members}
           ORDER BY id LIMIT ${batch}`);
        await visit(tx, found);
        return found;
      });
      if (users.length) after = users[users.length - 1]!.id;
      if (users.length < batch) break;
    }
  }

  /** Records the run in key_rotation_runs before and after the work. */
  private async recorded(
    kind: "field" | "mfa",
    targetVersion: number,
    options: RewrapOptions,
    work: (summary: RunSummary) => Promise<void>,
  ): Promise<RunSummary> {
    const operator = options.operator.trim();
    if (operator.length < 2 || operator.length > 100)
      throw new Error("--operator must name the person running the rotation (2–100 characters)");
    const summary: RunSummary = {
      runId: randomUUID(),
      kind,
      targetVersion,
      dryRun: options.dryRun ?? false,
      status: "completed",
      checked: 0,
      rewrapped: 0,
      failed: 0,
      columns: [],
      failures: [],
    };
    await this.db.keyRotationRun.create({
      data: {
        id: summary.runId,
        kind,
        targetVersion,
        tenantId: options.tenantId ?? null,
        dryRun: summary.dryRun,
        operator,
      },
    });
    try {
      await work(summary);
      summary.status = summary.failed ? "completed_with_errors" : "completed";
    } catch (error) {
      summary.status = "failed";
      throw error;
    } finally {
      summary.checked = summary.columns.reduce((sum, column) => sum + column.checked, 0);
      summary.rewrapped = summary.columns.reduce((sum, column) => sum + column.rewrapped, 0);
      await this.db.keyRotationRun.update({
        where: { id: summary.runId },
        data: {
          status: summary.status,
          rowsChecked: summary.checked,
          rowsRewrapped: summary.rewrapped,
          rowsFailed: summary.failed,
          details: {
            columns: summary.columns,
            failures: summary.failures,
          } as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
    }
    return summary;
  }
}

function columnResult(summary: RunSummary, table: string, column: string): ColumnResult {
  let result = summary.columns.find((entry) => entry.table === table && entry.column === column);
  if (!result) {
    result = { table, column, checked: 0, rewrapped: 0, failed: 0 };
    summary.columns.push(result);
  }
  return result;
}

function fail(summary: RunSummary, result: ColumnResult, reference: string): void {
  result.failed += 1;
  summary.failed += 1;
  if (summary.failures.length < MAX_FAILURES_LISTED) summary.failures.push(reference);
}
