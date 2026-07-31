// Freshness is modelled separately from data: a failed refresh keeps the last
// good data visible but flags it stale, records when it was last true, and the
// current request status is always the latest attempt — so views can never
// claim a green "200 · ok" from retained data.

import type { ErrorKind } from "./api";

export type LoadStatus = "loading" | "ready" | ErrorKind;

export interface LoadSnapshot<T> {
  status: LoadStatus;
  data: T | null;
  stale: boolean;
  lastSuccessAt: number | null;
  message?: string;
}

export type LoadOutcome<T> =
  | { ok: true; data: T; at: number }
  | { ok: false; kind: ErrorKind; message: string; at: number };

export function initialLoadState<T>(): LoadSnapshot<T> {
  return { status: "loading", data: null, stale: false, lastSuccessAt: null };
}

export function applyLoadOutcome<T>(
  previous: LoadSnapshot<T>,
  outcome: LoadOutcome<T>,
): LoadSnapshot<T> {
  if (outcome.ok) {
    return {
      status: "ready",
      data: outcome.data,
      stale: false,
      lastSuccessAt: outcome.at,
    };
  }
  return {
    status: outcome.kind,
    data: previous.data,
    stale: previous.data !== null,
    lastSuccessAt: previous.lastSuccessAt,
    message: outcome.message,
  };
}
