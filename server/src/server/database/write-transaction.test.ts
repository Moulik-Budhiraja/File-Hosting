import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Client, Transaction } from "@libsql/client";

import { closeWriteTransaction } from "./write-transaction";

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
