"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { apiFetch, isApiError, onUnauthorized } from "@/lib/api";
import type { MeResponse, PublicUser, Role } from "@/lib/types";

export type UnauthenticatedReason = "signed-out" | "session-expired";

// Non-secret marker: records that a session existed in this browser so a
// dead cookie can be reported as "session expired" instead of "signed out".
export const SESSION_MARKER_KEY = "fs.session-active";

export function markSessionActive(): void {
  try {
    window.localStorage.setItem(SESSION_MARKER_KEY, "1");
  } catch {
    // Storage failures only cost the expired-session banner.
  }
}

function clearSessionMarker(): void {
  try {
    window.localStorage.removeItem(SESSION_MARKER_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function hadSession(): boolean {
  try {
    return window.localStorage.getItem(SESSION_MARKER_KEY) === "1";
  } catch {
    return false;
  }
}

interface AuthContextValue {
  user: PublicUser;
  role: Role;
  isAdmin: boolean;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: React.ReactNode;
  onUnauthenticated: (reason: UnauthenticatedReason) => void;
}

export function AuthProvider({
  children,
  onUnauthenticated,
}: AuthProviderProps) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const reportedRef = useRef(false);
  const onUnauthenticatedRef = useRef(onUnauthenticated);
  onUnauthenticatedRef.current = onUnauthenticated;

  const report = useCallback((reason: UnauthenticatedReason) => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    onUnauthenticatedRef.current(reason);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await apiFetch<MeResponse>("/api/auth/me", {
        skipUnauthorizedHandler: true,
      });
      if (!result.user) {
        // Legacy service credentials never reach the browser session flow.
        report("signed-out");
        return;
      }
      setMe(result);
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        report(hadSession() ? "session-expired" : "signed-out");
      } else {
        setFailed(true);
      }
    }
  }, [report]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => onUnauthorized(() => report("session-expired")), [report]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", {
        method: "POST",
        skipUnauthorizedHandler: true,
      });
    } catch {
      // A dead session is already signed out; continue to the login page.
    }
    clearSessionMarker();
    report("signed-out");
  }, [report]);

  if (failed) {
    return (
      <main className="page-fallback">
        <p className="notice notice-danger" role="alert">
          Couldn&apos;t load your session. Nothing was changed.{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setFailed(false);
              void refresh();
            }}
          >
            Retry
          </button>
        </p>
      </main>
    );
  }

  if (!me?.user) {
    return (
      <main className="page-fallback">
        <p className="muted" role="status">
          loading session…
        </p>
      </main>
    );
  }

  return (
    <AuthContext.Provider
      value={{
        user: me.user,
        role: me.role,
        isAdmin: me.role === "admin",
        signOut,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth requires an AuthProvider");
  return value;
}
