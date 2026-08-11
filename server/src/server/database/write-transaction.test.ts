import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Client, Transaction } from "@libsql/client";

import {
  closeWriteTransaction,
  DatabaseWriteAdmissionError,
  runDatabaseWrite,
} from "./write-transaction";

describe("write transaction cleanup", () => {
  it("does not turn a committed mutation into a failure when replacement configuration fails", async () => {
    let closed = false;
    const transaction = {
      close() {
        closed = true;
      },
    } as unknown as Transaction;
    const client = {
      async execute() {
        throw new Error("replacement connection unavailable");
      },
    } as unknown as Client;

    await assert.doesNotReject(
      closeWriteTransaction(client, transaction, { foreignKeys: true }),
    );
    assert.equal(closed, true);
  });

  it("does not let client-side close cleanup mask the transaction outcome", async () => {
    let configured = 0;
    const transaction = {
      close() {
        throw new Error("close cleanup failed");
      },
    } as unknown as Transaction;
    const client = {
      async execute() {
        configured += 1;
        return { rows: [], columns: [], rowsAffected: 0 };
      },
    } as unknown as Client;

    await assert.doesNotReject(closeWriteTransaction(client, transaction));
    assert.equal(configured, 2);
  });
});

describe("write admission", () => {
  it("bounds queued writers by count and wait time, then recovers", async () => {
    let releaseOwner!: () => void;
    let ownerStarted!: () => void;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ownerStarted = resolve;
    });
    const url = `file:admission-${crypto.randomUUID()}.db`;
    const owner = runDatabaseWrite(
      url,
      async () => {
        ownerStarted();
        await ownerGate;
      },
      { admissionTimeoutMs: 500, maxPending: 1 },
    );
    await started;

    const timedOut = runDatabaseWrite(url, async () => "never", {
      admissionTimeoutMs: 30,
      maxPending: 1,
    });
    await assert.rejects(
      runDatabaseWrite(url, async () => "overloaded", {
        admissionTimeoutMs: 30,
        maxPending: 1,
      }),
      (error: unknown) =>
        error instanceof DatabaseWriteAdmissionError &&
        error.reason === "overloaded",
    );
    await assert.rejects(
      timedOut,
      (error: unknown) =>
        error instanceof DatabaseWriteAdmissionError &&
        error.reason === "timeout",
    );

    releaseOwner();
    await owner;
    assert.equal(
      await runDatabaseWrite(url, async () => "recovered", {
        admissionTimeoutMs: 30,
        maxPending: 1,
      }),
      "recovered",
    );
  });

  it("continues admission after admitted async and synchronous failures", async () => {
    const url = `file:admission-failure-${crypto.randomUUID()}.db`;
    await assert.rejects(
      runDatabaseWrite(url, async () => {
        throw new Error("synthetic write failure");
      }),
      /synthetic write failure/u,
    );
    await assert.rejects(
      runDatabaseWrite(url, () => {
        throw new Error("synthetic synchronous failure");
      }),
      /synthetic synchronous failure/u,
    );
    assert.equal(await runDatabaseWrite(url, async () => 42), 42);
  });
});
