"use client";

import { useCallback, useEffect, useRef } from "react";

export interface LoadTicket {
  signal: AbortSignal;
  /** True only while this ticket is still the newest load and the
   * component is mounted. Stale completions must not commit state. */
  current: () => boolean;
}

/**
 * Latest-wins loader guard: every begin() aborts the previous in-flight
 * request and hands back a ticket whose current() gate protects state
 * commits from out-of-order completions, retries, and unmount.
 */
export function useLatest(): { begin: () => LoadTicket } {
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const begin = useCallback((): LoadTicket => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    generationRef.current += 1;
    const generation = generationRef.current;
    return {
      signal: controller.signal,
      current: () => mountedRef.current && generation === generationRef.current,
    };
  }, []);

  return { begin };
}
