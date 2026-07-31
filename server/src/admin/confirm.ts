// Guard for destructive operations: the wrapped action can only run after an
// explicit request() followed by confirm(), and never runs concurrently.

export type ConfirmState = "idle" | "armed" | "running" | "done" | "error";

export interface ConfirmController {
  state(): ConfirmState;
  error(): unknown;
  request(): void;
  cancel(): void;
  confirm(): Promise<void>;
}

export function createConfirmController(
  action: () => Promise<void>,
  onChange?: (state: ConfirmState) => void,
): ConfirmController {
  let state: ConfirmState = "idle";
  let lastError: unknown = null;

  function transition(next: ConfirmState): void {
    state = next;
    onChange?.(state);
  }

  return {
    state: () => state,
    error: () => lastError,
    request() {
      if (state === "running") return;
      lastError = null;
      transition("armed");
    },
    cancel() {
      if (state === "running") return;
      transition("idle");
    },
    async confirm() {
      if (state !== "armed") return;
      transition("running");
      try {
        await action();
        transition("done");
      } catch (error) {
        lastError = error;
        transition("error");
      }
    },
  };
}
