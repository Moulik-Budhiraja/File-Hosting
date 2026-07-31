"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { AdminApiError, createAdminApi, type ErrorKind } from "./api";
import { authStore } from "./auth-store";

export const adminApi = createAdminApi({
  getToken: () => authStore.getToken(),
});

export function useToken(): string | null {
  return useSyncExternalStore(
    (listener) => authStore.subscribe(listener),
    () => authStore.getToken(),
    () => null,
  );
}

export type LoadStatus = "loading" | "ready" | ErrorKind;

export interface LoadState<T> {
  status: LoadStatus;
  data: T | null;
  message?: string;
  reload: () => void;
}

export function useAdminData<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
  options: { refreshMs?: number } = {},
): LoadState<T> {
  const [state, setState] = useState<{
    status: LoadStatus;
    data: T | null;
    message?: string;
  }>({ status: "loading", data: null });
  const [generation, setGeneration] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const token = useToken();

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function run(background: boolean) {
      if (!background)
        setState((previous) => ({ ...previous, status: "loading" }));
      try {
        const data = await loaderRef.current();
        if (cancelled) return;
        setState({ status: "ready", data });
      } catch (error) {
        if (cancelled) return;
        const kind =
          error instanceof AdminApiError ? error.kind : ("api" as const);
        const message =
          error instanceof Error ? error.message : "Unexpected error";
        setState((previous) => ({
          status: kind,
          // Keep stale data visible during background refresh failures.
          data: background ? previous.data : null,
          message,
        }));
      }
      if (options.refreshMs && !cancelled) {
        timer = setTimeout(() => void run(true), options.refreshMs);
      }
    }

    void run(false);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, token, options.refreshMs, ...deps]);

  return { ...state, reload };
}
