export type BannerState = "loading" | "empty" | "api" | "disconnected";

const COPY: Record<BannerState, string> = {
  loading: "loading from server …",
  empty: "no objects match the current filter",
  api: "the server rejected the request",
  disconnected: "server unreachable · check the connection and retry",
};

interface StateBannerProps {
  state: BannerState;
  message?: string;
  onRetry?: () => void;
}

export function StateBanner({ state, message, onRetry }: StateBannerProps) {
  const isError = state === "api" || state === "disconnected";
  return (
    <div
      className={`state-banner state-${state}`}
      role={isError ? "alert" : "status"}
    >
      <p>{state === "api" && message ? message : COPY[state]}</p>
      {isError && onRetry ? (
        <button type="button" className="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
