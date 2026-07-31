"use client";

import { authStore } from "../auth-store";
import type { LoadStatus } from "../client";
import { StateBanner } from "./StateBanner";

interface LoadFallbackProps {
  status: Exclude<LoadStatus, "ready"> | "empty";
  message?: string;
  onRetry?: () => void;
}

// Renders the truthful non-ready states: loading, empty, API error,
// disconnected, and rejected-token (which drops back to the token gate).
export function LoadFallback({ status, message, onRetry }: LoadFallbackProps) {
  if (status === "auth") {
    return (
      <div className="state-banner state-api" role="alert">
        <p>the server rejected the bearer token</p>
        <button
          type="button"
          className="button"
          onClick={() => authStore.clearToken()}
        >
          Re-enter token
        </button>
      </div>
    );
  }
  return <StateBanner state={status} message={message} onRetry={onRetry} />;
}
