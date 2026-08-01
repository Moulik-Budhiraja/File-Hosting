"use client";

import { useId, useRef, useState } from "react";

import { apiFetch, isApiError } from "@/lib/api";
import type { PublicUser } from "@/lib/types";

// onSuccess may be invoked with no expiry when a lost login response is
// reconciled through /api/auth/me (the expiry is not re-derivable there).

export type LoginNotice = "session-expired" | "password-changed";

interface LoginFormProps {
  onSuccess: (user: PublicUser, expiresAt?: string) => void;
  notice?: LoginNotice;
  initialUsername?: string;
}

type LoginState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "invalid" }
  | { kind: "throttled"; edited: boolean }
  | { kind: "server-error"; status: number }
  // Transport failed and the authoritative /api/auth/me probe confirmed
  // there is no session: not signed in (yet), retry freely.
  | { kind: "not-signed-in" }
  // The probe responded definitively with another cookie-backed identity.
  | { kind: "different-session"; username: string }
  // Transport failed and the probe could not confirm either way. The
  // cause keeps the copy truthful: a delivered non-401 probe error means
  // the server answered; only a dead transport means it didn't respond.
  | { kind: "unknown"; cause: "server-error" | "unreachable" };

export function LoginForm({
  onSuccess,
  notice,
  initialUsername = "",
}: LoginFormProps) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [state, setState] = useState<LoginState>({ kind: "idle" });
  const passwordRef = useRef<HTMLInputElement>(null);
  const usernameId = useId();
  const passwordId = useId();
  const errorId = useId();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (state.kind === "submitting") return;
    if (state.kind === "throttled" && !state.edited) return;
    setState({ kind: "submitting" });
    try {
      const result = await apiFetch<{
        user: PublicUser;
        expires_at: string;
      }>("/api/auth/login", {
        method: "POST",
        body: { username, password },
        skipUnauthorizedHandler: true,
      });
      onSuccess(result.user, result.expires_at);
    } catch (error) {
      if (isApiError(error) && error.status === 429) {
        setState({ kind: "throttled", edited: false });
        setPassword("");
        passwordRef.current?.focus();
      } else if (isApiError(error) && error.status === 401) {
        setState({ kind: "invalid" });
        setPassword("");
        passwordRef.current?.focus();
      } else if (isApiError(error)) {
        // A delivered error status is definitive for the client: no
        // session cookie was applied with it.
        setState({ kind: "server-error", status: error.status });
        setPassword("");
        passwordRef.current?.focus();
      } else {
        // A transport failure is ambiguous: the login may have committed
        // with only the response lost (the session cookie can arrive even
        // when the body does not). Ask the authoritative session endpoint
        // instead of guessing.
        setState(await reconcileAmbiguousLogin(username));
        setPassword("");
        passwordRef.current?.focus();
      }
    }
  }

  // Returns the truthful state after an ambiguous login failure. When the
  // server confirms a session for the intended user, sign-in completes
  // through the normal success path (session signal + safe next
  // navigation happen in onSuccess).
  async function reconcileAmbiguousLogin(
    intendedUsername: string,
  ): Promise<LoginState> {
    const intended = intendedUsername.trim().toLocaleLowerCase("en-US");
    try {
      const me = await apiFetch<{ user: PublicUser | null }>("/api/auth/me", {
        skipUnauthorizedHandler: true,
      });
      if (me.user?.username.toLocaleLowerCase("en-US") === intended) {
        onSuccess(me.user, undefined);
        return { kind: "idle" };
      }
      // A session for a different identity (or a legacy credential) is
      // not the sign-in the user asked for.
      return me.user
        ? { kind: "different-session", username: me.user.username }
        : { kind: "not-signed-in" };
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        return { kind: "not-signed-in" };
      }
      return {
        kind: "unknown",
        cause: isApiError(error) ? "server-error" : "unreachable",
      };
    }
  }

  const throttled = state.kind === "throttled";
  const locked = throttled && !state.edited;

  function markEdited() {
    if (throttled && !state.edited)
      setState({ kind: "throttled", edited: true });
  }

  return (
    <form className="login-form" onSubmit={submit} noValidate>
      {notice === "session-expired" ? (
        <p className="banner banner-warning" role="status">
          Session expired — sign in again to continue.
        </p>
      ) : null}
      {notice === "password-changed" ? (
        <p className="banner banner-success" role="status">
          Password changed — sign in again with your new password.
        </p>
      ) : null}
      <h1 className="section-label">Sign in</h1>
      <div className="field">
        <label htmlFor={usernameId}>Username</label>
        <input
          id={usernameId}
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
            markEdited();
          }}
        />
      </div>
      <div className="field">
        <label htmlFor={passwordId}>Password</label>
        <input
          id={passwordId}
          ref={passwordRef}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          aria-invalid={state.kind === "invalid" || undefined}
          aria-describedby={state.kind === "invalid" ? errorId : undefined}
          onChange={(event) => {
            setPassword(event.target.value);
            markEdited();
          }}
        />
      </div>
      <div aria-live="polite">
        {state.kind === "invalid" ? (
          <p className="field-error" id={errorId}>
            Username or password is incorrect.
          </p>
        ) : null}
        {throttled ? (
          <div className="notice notice-warning">
            <p className="notice-title">Too many attempts.</p>
            <p>
              Sign-in is temporarily locked for this address. Try again later.
            </p>
          </div>
        ) : null}
        {state.kind === "server-error" ? (
          <p className="field-error">
            The server couldn&apos;t sign you in ({state.status || "network"}).
            Try again.
          </p>
        ) : null}
        {state.kind === "not-signed-in" ? (
          <p className="field-error">
            Sign-in didn&apos;t complete — you&apos;re not signed in. Check your
            connection and try again.
          </p>
        ) : null}
        {state.kind === "different-session" ? (
          <p className="field-error">
            You&apos;re still signed in as {state.username}. This sign-in
            didn&apos;t take effect in this browser. Check your connection and
            try again.
          </p>
        ) : null}
        {state.kind === "unknown" ? (
          <p className="field-error">
            {state.cause === "server-error"
              ? "We couldn't confirm whether sign-in completed — the server returned an error. Try again."
              : "We couldn't confirm whether sign-in completed — the server didn't respond. Check your connection and try again."}
          </p>
        ) : null}
      </div>
      <button
        type="submit"
        className="button button-primary button-block"
        disabled={state.kind === "submitting" || locked}
      >
        {locked
          ? "Sign in — locked"
          : state.kind === "submitting"
            ? "Signing in…"
            : "Sign in"}
      </button>
    </form>
  );
}
