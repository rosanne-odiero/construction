/**
 * Whether a database error, or one it wraps, carries one of these codes (a Prisma code such as
 * P2002 or a PostgreSQL SQLSTATE). Prisma's driver adapter reports the SQLSTATE at
 * `meta.driverAdapterError.cause.code`.
 */
export function hasDatabaseCode(error: unknown, codes: readonly string[]): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const fields = current as Record<string, unknown>;
    if (codes.includes(String(fields["code"])) || codes.includes(String(fields["originalCode"])))
      return true;
    pending.push(fields["cause"], fields["meta"], fields["driverAdapterError"]);
  }
  return false;
}

/** unique_violation */
export const isUniqueViolation = (error: unknown) => hasDatabaseCode(error, ["P2002", "23505"]);
/** check_violation, also raised by the lifecycle and append-only triggers */
export const isCheckViolation = (error: unknown) => hasDatabaseCode(error, ["23514"]);
/** foreign_key_violation */
export const isForeignKeyViolation = (error: unknown) => hasDatabaseCode(error, ["P2003", "23503"]);
