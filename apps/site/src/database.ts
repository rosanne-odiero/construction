import type { Connection, Database } from "./store.ts";

/** Keep every transaction on the already-keyed SQLCipher connection, and serialize ALL access. */
export function serializeDatabase(
  native: Connection & { execAsync(sql: string): Promise<void> },
): Database {
  let tail: Promise<unknown> = Promise.resolve();
  function locked<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  return {
    runAsync: (sql, ...params) => locked(() => native.runAsync(sql, ...params)),
    getFirstAsync: <T>(sql: string, ...params: (string | number | null)[]) =>
      locked(() => native.getFirstAsync<T>(sql, ...params)),
    getAllAsync: <T>(sql: string, ...params: (string | number | null)[]) =>
      locked(() => native.getAllAsync<T>(sql, ...params)),
    execAsync: (sql) => locked(() => native.execAsync(sql)),
    withExclusiveTransactionAsync: (task) =>
      locked(async () => {
        await native.execAsync("BEGIN IMMEDIATE");
        try {
          await task(native);
          await native.execAsync("COMMIT");
        } catch (error) {
          await native.execAsync("ROLLBACK");
          throw error;
        }
      }),
  };
}
