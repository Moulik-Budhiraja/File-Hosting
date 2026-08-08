import { AsyncLocalStorage } from "node:async_hooks";

import type { Client, Transaction } from "@libsql/client";

interface PendingWrite {
  start: () => void;
  timer: NodeJS.Timeout;
}

interface WriteQueue {
  active: boolean;
  pending: PendingWrite[];
}

const writeQueues = new Map<string, WriteQueue>();
const activeWriteDatabases = new AsyncLocalStorage<ReadonlySet<string>>();

export const DATABASE_WRITE_MAX_PENDING = 256;

export class DatabaseWriteAdmissionError extends Error {
  constructor(public readonly reason: "overloaded" | "timeout") {
    super(
      reason === "overloaded"
        ? "database write admission overloaded"
        : "database write admission timed out",
    );
    this.name = "DatabaseWriteAdmissionError";
  }
}

function releaseWrite(databaseUrl: string, queue: WriteQueue): void {
  const next = queue.pending.shift();
  if (next) {
    clearTimeout(next.timer);
    next.start();
    return;
  }
  queue.active = false;
  if (writeQueues.get(databaseUrl) === queue) writeQueues.delete(databaseUrl);
}

/**
 * Serialize same-process writers before they attempt BEGIN. The async-local
 * context makes nested repository helpers re-entrant without deadlocking,
 * while distinct database URLs remain independent.
 */
export function runDatabaseWrite<T>(
  databaseUrl: string,
  task: () => Promise<T>,
  options: {
    admissionTimeoutMs?: number;
    maxPending?: number;
  } = {},
): Promise<T> {
  const active = activeWriteDatabases.getStore();
  if (active?.has(databaseUrl)) return task();

  const admissionTimeoutMs =
    options.admissionTimeoutMs ?? DATABASE_BUSY_TIMEOUT_MS;
  const maxPending = options.maxPending ?? DATABASE_WRITE_MAX_PENDING;
  let queue = writeQueues.get(databaseUrl);
  if (!queue) {
    queue = { active: false, pending: [] };
    writeQueues.set(databaseUrl, queue);
  }
  if (queue.active && queue.pending.length >= maxPending) {
    return Promise.reject(new DatabaseWriteAdmissionError("overloaded"));
  }

  return new Promise<T>((resolve, reject) => {
    const start = () => {
      queue.active = true;
      void Promise.resolve()
        .then(() =>
          activeWriteDatabases.run(
            new Set([...(active ?? []), databaseUrl]),
            task,
          ),
        )
        .then(resolve, reject)
        .finally(() => releaseWrite(databaseUrl, queue));
    };
    if (!queue.active) {
      start();
      return;
    }
    const pending = {} as PendingWrite;
    pending.start = start;
    pending.timer = setTimeout(() => {
      const index = queue.pending.indexOf(pending);
      if (index < 0) return;
      queue.pending.splice(index, 1);
      reject(new DatabaseWriteAdmissionError("timeout"));
    }, admissionTimeoutMs);
    queue.pending.push(pending);
  });
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
