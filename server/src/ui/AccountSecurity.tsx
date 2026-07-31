"use client";

import Link from "next/link";
import { useId, useState } from "react";

import { apiFetch, isApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDate } from "@/lib/format";
import {
  MAX_PASSWORD_UTF8_BYTES,
  MIN_PASSWORD_CODE_POINTS,
  checkPassword,
} from "@/lib/password-policy";

type FormState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "current-rejected"; message: string }
  | { kind: "new-rejected"; message: string }
  | { kind: "server-error"; status: number };

interface AccountSecurityProps {
  // Invoked after the backend confirms the change (which revokes every
  // session, including this one). The page routes to the truthful
  // "password changed — sign in again" login state.
  onPasswordChanged: () => void;
}

export function AccountSecurity({ onPasswordChanged }: AccountSecurityProps) {
  const { user, signOut } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newError, setNewError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [state, setState] = useState<FormState>({ kind: "idle" });
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const currentId = useId();
  const newId = useId();
  const confirmId = useId();
  const newErrorId = useId();
  const confirmErrorId = useId();
  const currentErrorId = useId();

  const newFieldInvalid = newError !== null || state.kind === "new-rejected";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (state.kind === "submitting") return;
    const check = checkPassword(newPassword);
    const differs = confirmPassword !== newPassword;
    setNewError(
      check.ok
        ? null
        : check.reason === "too-short"
          ? `Too short — ${check.codePoints} of ${MIN_PASSWORD_CODE_POINTS} minimum characters.`
          : `Too long — ${check.bytes} of ${MAX_PASSWORD_UTF8_BYTES} maximum UTF-8 bytes.`,
    );
    setMismatch(differs);
    if (!check.ok || differs) return;
    setState({ kind: "submitting" });
    try {
      await apiFetch("/api/auth/password", {
        method: "POST",
        body: {
          current_password: currentPassword,
          new_password: newPassword,
        },
        skipUnauthorizedHandler: true,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setState({ kind: "idle" });
      onPasswordChanged();
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        setState({
          kind: "current-rejected",
          message: "Current password is invalid.",
        });
      } else if (
        isApiError(error) &&
        error.status === 400 &&
        error.code === "invalid_password"
      ) {
        // The server judged the NEW password invalid — the error belongs
        // to the new-password field, not the current-credential field.
        setState({ kind: "new-rejected", message: `${error.message}.` });
      } else if (isApiError(error) && error.status === 400) {
        setState({ kind: "current-rejected", message: `${error.message}.` });
      } else {
        setState({
          kind: "server-error",
          status: isApiError(error) ? error.status : 0,
        });
      }
    }
  }

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutFailed(false);
    const result = await signOut();
    setSigningOut(false);
    if (!result.ok) setSignOutFailed(true);
  }

  return (
    <div className="account-grid">
      <section className="account-form-region" aria-label="Change password">
        <h2 className="section-label">Change password</h2>
        <div aria-live="polite">
          {state.kind === "server-error" ? (
            <div className="notice notice-danger">
              <p className="notice-title">Password not changed.</p>
              <p>
                The server couldn&apos;t complete the request (
                {state.status || "network"}). Your current password still works.
                Try again.
              </p>
            </div>
          ) : null}
        </div>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor={currentId}>Current password</label>
            <input
              id={currentId}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              aria-invalid={state.kind === "current-rejected" || undefined}
              aria-describedby={
                state.kind === "current-rejected" ? currentErrorId : undefined
              }
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
            {state.kind === "current-rejected" ? (
              <p className="field-error" id={currentErrorId}>
                {state.message}
              </p>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor={newId}>New password</label>
            <input
              id={newId}
              type="password"
              autoComplete="new-password"
              value={newPassword}
              aria-invalid={newFieldInvalid || undefined}
              aria-describedby={newFieldInvalid ? newErrorId : undefined}
              onChange={(event) => {
                setNewPassword(event.target.value);
                setNewError(null);
                if (state.kind === "new-rejected") setState({ kind: "idle" });
              }}
            />
            {newFieldInvalid ? (
              <p className="field-error" id={newErrorId}>
                {state.kind === "new-rejected" ? state.message : newError}
              </p>
            ) : (
              <p className="field-hint">
                min 12 characters · max 72 UTF-8 bytes · stored as salted bcrypt
                hash
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor={confirmId}>Confirm new password</label>
            <input
              id={confirmId}
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              aria-invalid={mismatch || undefined}
              aria-describedby={mismatch ? confirmErrorId : undefined}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                setMismatch(false);
              }}
            />
            {mismatch ? (
              <p className="field-error" id={confirmErrorId}>
                Doesn&apos;t match the new password.
              </p>
            ) : null}
          </div>
          <button
            type="submit"
            className="button button-primary"
            disabled={state.kind === "submitting"}
          >
            {state.kind === "submitting" ? "Changing…" : "Change password"}
          </button>
          <p className="form-footnote">
            changing your password signs out every session for this account ·
            API keys keep working
          </p>
        </form>
      </section>
      <aside className="account-session" aria-label="This session">
        <h2 className="section-label">This session</h2>
        <dl className="fact-list">
          <div className="fact-row">
            <dt>signed in as</dt>
            <dd>{user.username}</dd>
          </div>
          <div className="fact-row">
            <dt>role</dt>
            <dd>{user.role}</dd>
          </div>
          <div className="fact-row">
            <dt>account created</dt>
            <dd>{formatDate(user.created_at)}</dd>
          </div>
          <div className="fact-row">
            <dt>session</dt>
            <dd>cookie httpOnly · expires 7 days after sign-in</dd>
          </div>
          <div className="fact-row">
            <dt>cli</dt>
            <dd>
              uses API keys, not this session →{" "}
              <Link href="/keys">API Keys</Link>
            </dd>
          </div>
        </dl>
        <div aria-live="polite">
          {signOutFailed ? (
            <p className="notice notice-danger" role="alert">
              Couldn&apos;t sign out — you are still signed in. Check your
              connection and try again.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="button"
          disabled={signingOut}
          onClick={() => void handleSignOut()}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </aside>
    </div>
  );
}
