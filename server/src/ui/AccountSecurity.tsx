"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

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
  // The server answered with a non-field error: the transaction rolled
  // back, so the password is unchanged and retry is safe.
  | { kind: "server-error" }
  // The server rejected the session itself (revoked/expired) before
  // judging any credential — only re-authentication can proceed.
  | { kind: "session-ended" }
  // No response was delivered at all; the commit may or may not have
  // happened.
  | { kind: "outcome-unknown" };

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
  const recoveryLinkRef = useRef<HTMLAnchorElement | null>(null);

  // Only the genuine lost-response transition re-homes the keyboard: the
  // submit button it was on is disabled mid-flight, so focus would
  // otherwise fall back to the document body.
  useEffect(() => {
    if (state.kind === "outcome-unknown") recoveryLinkRef.current?.focus();
  }, [state.kind]);

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
      if (
        isApiError(error) &&
        error.status === 401 &&
        error.code === "invalid_credentials"
      ) {
        setState({
          kind: "current-rejected",
          message: "Current password is invalid.",
        });
      } else if (isApiError(error) && error.status === 401) {
        // The session died (revoked/expired/disabled) before any credential
        // was judged. Drop the typed credentials — this page can no longer
        // act on them — and point at re-authentication.
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setState({ kind: "session-ended" });
      } else if (
        isApiError(error) &&
        error.status === 400 &&
        error.code === "invalid_password"
      ) {
        // The server judged the NEW password invalid — the error belongs
        // to the new-password field, not the current-credential field.
        setState({ kind: "new-rejected", message: `${error.message}.` });
      } else if (isApiError(error)) {
        // The error response was DELIVERED, so the outcome is known: the
        // password route rolls back on any error and only commits before
        // its 204, so nothing changed and retry is safe.
        setState({ kind: "server-error" });
      } else {
        // The server may have committed the password and revoked every
        // session before response delivery failed. Clear both credentials
        // so the form cannot encourage an unsafe blind replay, then direct
        // the user to a recovery path that is valid for either outcome.
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setState({ kind: "outcome-unknown" });
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
          {state.kind === "outcome-unknown" ? (
            <div className="notice notice-danger">
              <p className="notice-title">Password change outcome unknown.</p>
              <p>
                The response was lost. Your password may have changed and every
                browser session may have been signed out. Go to sign in and use
                the new password first. If you cannot sign in, ask an
                administrator to reset your password.
              </p>
              <Link href="/login?next=%2Faccount" ref={recoveryLinkRef}>
                Go to sign in
              </Link>
            </div>
          ) : null}
          {state.kind === "server-error" ? (
            <div className="notice notice-danger">
              <p className="notice-title">Password not changed.</p>
              <p>
                The server returned an error and did not apply the change. Try
                again — if it keeps failing, ask an administrator.
              </p>
            </div>
          ) : null}
          {state.kind === "session-ended" ? (
            <div className="notice notice-danger">
              <p className="notice-title">
                Session ended — password not changed.
              </p>
              <p>
                Your session is no longer valid — it expired or was revoked.
                Sign in again to change your password.
              </p>
              <Link href="/login?next=%2Faccount">Go to sign in</Link>
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
                min 12 characters · max 72 UTF-8 bytes
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
            changing your password signs out every session for this account
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
