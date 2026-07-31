import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { authStore } from "./auth-store";

interface StorageStub {
  written: Record<string, string>;
  setItem(key: string, value: string): void;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

function storageStub(): StorageStub {
  return {
    written: {},
    setItem(key: string, value: string) {
      this.written[key] = value;
    },
    getItem(key: string) {
      return this.written[key] ?? null;
    },
    removeItem(key: string) {
      delete this.written[key];
    },
  };
}

describe("authStore", () => {
  const globals = globalThis as unknown as Record<string, unknown> & {
    localStorage?: StorageStub;
    sessionStorage?: StorageStub;
  };

  beforeEach(() => {
    globals.localStorage = storageStub();
    globals.sessionStorage = storageStub();
    authStore.clearToken();
  });

  afterEach(() => {
    delete globals.localStorage;
    delete globals.sessionStorage;
    authStore.clearToken();
  });

  it("starts without a token", () => {
    assert.equal(authStore.getToken(), null);
  });

  it("holds the token in memory and notifies subscribers", () => {
    let notifications = 0;
    const unsubscribe = authStore.subscribe(() => {
      notifications += 1;
    });
    authStore.setToken("super-secret-token");
    assert.equal(authStore.getToken(), "super-secret-token");
    assert.equal(notifications, 1);
    authStore.clearToken();
    assert.equal(authStore.getToken(), null);
    assert.equal(notifications, 2);
    unsubscribe();
    authStore.setToken("another");
    assert.equal(notifications, 2);
  });

  it("never writes the token to web storage", () => {
    authStore.setToken("super-secret-token");
    assert.deepEqual(globals.localStorage?.written, {});
    assert.deepEqual(globals.sessionStorage?.written, {});
  });

  it("rejects blank tokens", () => {
    authStore.setToken("   ");
    assert.equal(authStore.getToken(), null);
  });
});
