import { afterEach, expect, test, vi } from "vitest";

import {
  publishSessionChange,
  SESSION_VERSION_KEY,
  subscribeSessionChange,
} from "@/lib/session-signal";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

test("every publish writes a fresh non-secret version value", () => {
  publishSessionChange();
  const first = window.localStorage.getItem(SESSION_VERSION_KEY);
  expect(first).toBeTruthy();
  publishSessionChange();
  const second = window.localStorage.getItem(SESSION_VERSION_KEY);
  expect(second).toBeTruthy();
  // The value must change on every authentication transition — writing
  // the same value would suppress the cross-tab storage event entirely.
  expect(second).not.toBe(first);
});

test("publish survives restricted storage and a missing BroadcastChannel", () => {
  const denied = () => {
    throw new DOMException("denied", "SecurityError");
  };
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(denied);
  vi.stubGlobal("BroadcastChannel", undefined);
  expect(() => publishSessionChange()).not.toThrow();
});

test("subscribers hear same-tab BroadcastChannel publishes", async () => {
  const heard = vi.fn();
  const unsubscribe = subscribeSessionChange(heard);
  publishSessionChange();
  await vi.waitFor(() => expect(heard).toHaveBeenCalled());
  unsubscribe();
});

test("subscribers hear cross-tab storage events for the version key", () => {
  const heard = vi.fn();
  const unsubscribe = subscribeSessionChange(heard);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: SESSION_VERSION_KEY,
      newValue: "other-tab-version",
    }),
  );
  expect(heard).toHaveBeenCalledTimes(1);
  unsubscribe();
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: SESSION_VERSION_KEY,
      newValue: "another-version",
    }),
  );
  expect(heard).toHaveBeenCalledTimes(1);
});

test("subscribe works without BroadcastChannel at all", () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const heard = vi.fn();
  const unsubscribe = subscribeSessionChange(heard);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: SESSION_VERSION_KEY,
      newValue: "v2",
    }),
  );
  expect(heard).toHaveBeenCalledTimes(1);
  unsubscribe();
});
