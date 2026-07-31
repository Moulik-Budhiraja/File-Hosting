"use client";

import { authStore } from "../auth-store";
import type { LoadStatus } from "../load-state";
import { formatUtcDateTime } from "../format";

interface StaleBannerProps {
  status: LoadStatus;
  message?: string;
  lastSuccessAt: number | null;
  onRetry: () => void;
}

// Shown when a view still displays retained data after a failed refresh: the
// data below is STALE and nothing on the page may claim current success.
export function StaleBanner({
  status,
  message,
  lastSuccessAt,
  onRetry,
}: StaleBannerProps) {
  if (status === "ready" || status === "loading") return null;
  const reason =
    status === "disconnected"
      ? "server unreachable"
      : status === "auth"
        ? "the server rejected the bearer token"
        : (message ?? "the server rejected the request");
  return (
    <div className="state-banner state-stale" role="alert">
      <p>
        <strong>stale data</strong> — refresh failed ({reason}) · showing the
        last successful load
        {lastSuccessAt !== null
          ? ` from ${formatUtcDateTime(new Date(lastSuccessAt).toISOString())}`
          : ""}
      </p>
      {status === "auth" ? (
        <button
          type="button"
          className="button"
          onClick={() => authStore.clearToken()}
        >
          Re-enter token
        </button>
      ) : (
        <button type="button" className="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
