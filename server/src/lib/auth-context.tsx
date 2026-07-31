"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { apiFetch, isApiError, onForbidden, onUnauthorized } from "@/lib/api";
import {
  safeStorageGet,
  safeStorageRemove,
  safeStorageSet,
} from "@/lib/safe-storage";
import {
  publishSessionChange,
  subscribeSessionChange,
} from "@/lib/session-signal";
import type { MeResponse, PublicUser, Role } from "@/lib/types";

export type UnauthenticatedReason = "signed-out" | "session-expired";

// Non-secret marker: records that a session existed in this browser so a
// dead cookie can be reported as "session expired" instead of "signed out".
export const SESSION_MARKER_KEY = "fs.session-active";

// Focus/visibility refreshes are best-effort; anything more frequent than
// this is a request storm, not fresher identity.
const BACKGROUND_REFRESH_MIN_INTERVAL_MS = 30_000;

// Defensive fallback for cookie changes made outside any coordinated app
// flow (no storage/broadcast signal to hear): a low-frequency bounded
// poll while the tab is visible. Real transitions propagate immediately
// via the session-change signal.
const SESSION_POLL_INTERVAL_MS = 60_000;

export function markSessionActive(): void {
  safeStorageSet(SESSION_MARKER_KEY, "1");
}

function clearSessionMarker(): void {
  safeStorageRemove(SESSION_MARKER_KEY);
}

function hadSession(): boolean {
  return safeStorageGet(SESSION_MARKER_KEY) === "1";
}

export interface SignOutResult {
  ok: boolean;
}

interface AuthContextValue {
  user: PublicUser;
  role: Role;
  isAdmin: boolean;
  signOut: () => Promise<SignOutResult>;
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
  const [stale, setStale] = useState(false);
  const hasIdentityRef = useRef(false);
  const reportedRef = useRef(false);
  const mountedRef = useRef(true);
  const inflightRef = useRef<Promise<void> | null>(null);
  const lastRefreshRef = useRef(0);
  const onUnauthenticatedRef = useRef(onUnauthenticated);
  onUnauthenticatedRef.current = onUnauthenticated;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const report = useCallback((reason: UnauthenticatedReason) => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    onUnauthenticatedRef.current(reason);
  }, []);

  const refresh = useCallback(async () => {
    // Collapse concurrent refresh triggers (focus + storage + 403 can all
    // fire together) into one request.
    if (inflightRef.current) return inflightRef.current;
    const task = (async () => {
      try {
        const result = await apiFetch<MeResponse>("/api/auth/me", {
          skipUnauthorizedHandler: true,
        });
        if (!mountedRef.current) return;
        if (!result.user) {
          // Legacy service credentials never reach the browser session flow.
          report("signed-out");
          return;
        }
        hasIdentityRef.current = true;
        setMe(result);
        setStale(false);
      } catch (error) {
        if (!mountedRef.current) return;
        if (isApiError(error) && error.status === 401) {
          report(hadSession() ? "session-expired" : "signed-out");
        } else if (hasIdentityRef.current) {
          // A failed BACKGROUND refresh must not tear down a working UI:
          // keep the last known identity rendered and say it is stale.
          setStale(true);
        } else {
          setFailed(true);
        }
      } finally {
        lastRefreshRef.current = Date.now();
        inflightRef.current = null;
      }
    })();
    inflightRef.current = task;
    return task;
  }, [report]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => onUnauthorized(() => report("session-expired")), [report]);

  // Authoritative 403s mean the server disagrees with the rendered role —
  // refresh the identity before any further privileged rendering/fan-out.
  useEffect(() => onForbidden(() => void refresh()), [refresh]);

  // Real cross-tab transitions (login, session replacement, logout)
  // publish a changing session version through storage + BroadcastChannel.
  // Refresh immediately — a "recent" identity read is exactly what a
  // possible account switch invalidates, so no interval guard here.
  useEffect(() => subscribeSessionChange(() => void refresh()), [refresh]);

  // Low-frequency bounded poll: catches cookie changes that had no
  // coordinated signal at all. Paused while hidden (the visibilitychange
  // refresh catches up on return); interval-guarded against storms.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (
        Date.now() - lastRefreshRef.current <
        BACKGROUND_REFRESH_MIN_INTERVAL_MS
      ) {
        return;
      }
      void refresh();
    }, SESSION_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Identity can drift while this tab is inactive (role changes, another
  // account signing in from a second tab). Refresh on focus/visibility with
  // an interval guard, and immediately on cross-tab session-marker writes.
  useEffect(() => {
    const backgroundRefresh = () => {
      if (
        Date.now() - lastRefreshRef.current <
        BACKGROUND_REFRESH_MIN_INTERVAL_MS
      ) {
        return;
      }
      void refresh();
    };
    const onFocus = () => backgroundRefresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") backgroundRefresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === SESSION_MARKER_KEY) {
        void refresh();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh]);

  const signOut = useCallback(async (): Promise<SignOutResult> => {
    try {
      await apiFetch("/api/auth/logout", {
        method: "POST",
        skipUnauthorizedHandler: true,
      });
    } catch (error) {
      if (!(isApiError(error) && error.status === 401)) {
        // Network failure or 5xx: the server session may still be alive.
        // Stay signed in and let the caller surface an actionable error.
        return { ok: false };
      }
      // 401 = the session is verifiably dead; treat as signed out.
    }
    clearSessionMarker();
    // Tell every other tab the session is gone.
    publishSessionChange();
    report("signed-out");
    return { ok: true };
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
      {stale ? (
        <p className="stale-banner" role="status">
          Session info couldn&apos;t be refreshed — showing the last known
          state.{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => void refresh()}
          >
            Retry
          </button>
        </p>
      ) : null}
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth requires an AuthProvider");
  return value;
}
