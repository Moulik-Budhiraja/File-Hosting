import { AsyncLocalStorage } from "node:async_hooks";

const TRANSITIVE_NATIVE_BUDGET_MIB = 384;
let active = false;
const admissionContext = new AsyncLocalStorage<boolean>();
const waiters: Array<{
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}> = [];

export async function acquireNativeAdmission(timeoutMs: number): Promise<void> {
  if (!active) {
    active = true;
    return;
  }
  if (waiters.length >= 32) throw new Error("native admission queue is full");
  await new Promise<void>((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(
        () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("native admission queue wait timed out"));
        },
        Math.max(1, timeoutMs),
      ),
    };
    waiters.push(waiter);
  });
}

export function releaseNativeAdmission(): void {
  const next = waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
    return;
  }
  active = false;
}

export async function withNativeAdmission<T>(
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (admissionContext.getStore()) return operation();
  await acquireNativeAdmission(timeoutMs);
  try {
    return await admissionContext.run(true, operation);
  } finally {
    releaseNativeAdmission();
  }
}

export function nativeAdmissionState(): {
  active: number;
  queued: number;
  budgetMiB: number;
} {
  return {
    active: active ? 1 : 0,
    queued: waiters.length,
    budgetMiB: TRANSITIVE_NATIVE_BUDGET_MIB,
  };
}
