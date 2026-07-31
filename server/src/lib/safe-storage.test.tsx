import { afterEach, expect, test, vi } from "vitest";

import {
  safeStorageGet,
  safeStorageRemove,
  safeStorageSet,
} from "./safe-storage";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

test("reads, writes, and removes normally when storage works", () => {
  expect(safeStorageSet("k", "v")).toBe(true);
  expect(safeStorageGet("k")).toBe("v");
  expect(safeStorageRemove("k")).toBe(true);
  expect(safeStorageGet("k")).toBe(null);
});

test("getItem throwing SecurityError degrades to null", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  expect(safeStorageGet("k")).toBe(null);
});

test("setItem throwing (quota/private mode) degrades to false", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  expect(safeStorageSet("k", "v")).toBe(false);
});

test("removeItem throwing degrades to false", () => {
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  expect(safeStorageRemove("k")).toBe(false);
});

test("localStorage accessor itself throwing degrades without crash", () => {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("denied", "SecurityError");
    },
  });
  try {
    expect(safeStorageGet("k")).toBe(null);
    expect(safeStorageSet("k", "v")).toBe(false);
    expect(safeStorageRemove("k")).toBe(false);
  } finally {
    if (original) Object.defineProperty(window, "localStorage", original);
  }
});
