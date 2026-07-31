"use client";

import { useId, useRef, useState } from "react";

import { apiFetch, isApiError } from "@/lib/api";
import type { PublicUser } from "@/lib/types";

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
  | { kind: "server-error"; status: number };

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
      } else {
        setState({
          kind: "server-error",
          status: isApiError(error) ? error.status : 0,
        });
        setPassword("");
        passwordRef.current?.focus();
      }
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
            Nothing was changed. Try again.
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
      <p className="form-footnote">
        CLI access uses personal API keys · fs auth set
      </p>
    </form>
  );
}
