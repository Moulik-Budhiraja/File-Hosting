import { AsyncLocalStorage } from "node:async_hooks";

import type { Client, Transaction } from "@libsql/client";

const writeQueues = new Map<string, Promise<void>>();
const activeWriteDatabases = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Serialize same-process writers before they attempt BEGIN. The async-local
 * context makes nested repository helpers re-entrant without deadlocking,
 * while distinct database URLs remain independent.
 */
export function runDatabaseWrite<T>(
  databaseUrl: string,
  task: () => Promise<T>,
): Promise<T> {
  const active = activeWriteDatabases.getStore();
  if (active?.has(databaseUrl)) return task();

  const previous = writeQueues.get(databaseUrl) ?? Promise.resolve();
  const run = previous.then(
    () =>
      activeWriteDatabases.run(new Set([...(active ?? []), databaseUrl]), task),
    () =>
      activeWriteDatabases.run(new Set([...(active ?? []), databaseUrl]), task),
  );
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(databaseUrl, settled);
  void settled.finally(() => {
    if (writeQueues.get(databaseUrl) === settled)
      writeQueues.delete(databaseUrl);
  });
  return run;
}

export const DATABASE_BUSY_TIMEOUT_MS = 5_000;
const BUSY_RETRY_INTERVAL_MS = 25;

function isDatabaseBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "SQLITE_BUSY"
  );
}

async function configureConnection(
  client: Client,
  options: { foreignKeys?: boolean } = {},
): Promise<void> {
  await client.execute(`PRAGMA busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
  await client.execute(
    `PRAGMA foreign_keys = ${options.foreignKeys === false ? "OFF" : "ON"}`,
  );
}

export async function configuredWrite<T>(
  client: Client,
  run: () => Promise<T>,
  options: { foreignKeys?: boolean } = {},
): Promise<T> {
  const deadline = Date.now() + DATABASE_BUSY_TIMEOUT_MS;
  for (;;) {
    await configureConnection(client, options);
    try {
      return await run();
    } catch (error) {
      if (!isDatabaseBusy(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, BUSY_RETRY_INTERVAL_MS),
      );
    }
  }
}

export async function beginWriteTransaction(
  client: Client,
  options: { retryBusy?: boolean; foreignKeys?: boolean } = {},
): Promise<Transaction> {
  const deadline = Date.now() + DATABASE_BUSY_TIMEOUT_MS;
  for (;;) {
    await configureConnection(client, options);
    try {
      return await client.transaction("write");
    } catch (error) {
      if (
        !options.retryBusy ||
        !isDatabaseBusy(error) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, BUSY_RETRY_INTERVAL_MS),
      );
    }
  }
}

export async function closeWriteTransaction(
  client: Client,
  transaction: Transaction,
  options: { foreignKeys?: boolean } = {},
): Promise<void> {
  // Commit/rollback has already established the mutation outcome. Cleanup or
  // replacement-connection failures must not turn that outcome into a false
  // API failure that invites an unsafe retry. Every later write configures its
  // connection again before use.
  try {
    transaction.close();
  } catch {
    // Best-effort client cleanup after the database outcome is final.
  }
  try {
    // @libsql/client detaches the transaction's connection. Configure the
    // lazily opened replacement immediately when it is available.
    await configureConnection(client, options);
  } catch {
    // The next write retries this configuration before it starts.
  }
}
