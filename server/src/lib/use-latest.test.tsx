import { renderHook } from "@testing-library/react";
import { expect, test } from "vitest";

import { useLatest } from "./use-latest";

test("beginning a new load aborts the previous one and marks it stale", () => {
  const { result } = renderHook(() => useLatest());
  const first = result.current.begin();
  expect(first.signal.aborted).toBe(false);
  expect(first.current()).toBe(true);

  const second = result.current.begin();
  expect(first.signal.aborted).toBe(true);
  expect(first.current()).toBe(false);
  expect(second.current()).toBe(true);
  expect(second.signal.aborted).toBe(false);
});

test("unmount aborts the active load and marks it stale", () => {
  const { result, unmount } = renderHook(() => useLatest());
  const ticket = result.current.begin();
  unmount();
  expect(ticket.signal.aborted).toBe(true);
  expect(ticket.current()).toBe(false);
});
