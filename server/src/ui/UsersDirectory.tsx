"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { apiFetch, isApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useLatest } from "@/lib/use-latest";
import { formatDate } from "@/lib/format";
import { generateTempPassword } from "@/lib/password";
import { newRequestId, RequestIdUnavailableError } from "@/lib/request-id";
import type { PublicUser, Role } from "@/lib/types";
import { Dialog } from "./Dialog";
import { SecretOnceDialog } from "./SecretOnceDialog";

type ListState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; users: PublicUser[] };

interface SecretResult {
  kind: "created" | "reset";
  username: string;
  password: string;
}

interface Conflict {
  verb: string;
  username: string;
}

type Confirm =
  | { kind: "disable"; user: PublicUser }
  | { kind: "enable"; user: PublicUser }
  | { kind: "role"; user: PublicUser; nextRole: Role }
  | { kind: "reset"; user: PublicUser };

export function formatMobileLastActive(
  iso: string | null,
  now = new Date(),
): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (daysAgo === 0) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(
      date.getMinutes(),
    ).padStart(2, "0")}`;
  }
  if (daysAgo === 1) return "yesterday";
  const formatted = formatDate(iso);
  return date.getFullYear() === now.getFullYear()
    ? formatted.replace(`, ${now.getFullYear()}`, "")
    : formatted;
}

export function UsersDirectory() {
  const { user: viewer } = useAuth();
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | Role>("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "disabled"
  >("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createUsername, setCreateUsername] = useState("");
  const [createRole, setCreateRole] = useState<Role>("member");
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [secret, setSecret] = useState<SecretResult | null>(null);
  const [sheetUser, setSheetUser] = useState<PublicUser | null>(null);
  const [reconcileNotice, setReconcileNotice] = useState<string | null>(null);
  const searchId = useId();
  const usernameId = useId();
  const usernameErrorId = useId();
  const usernameRef = useRef<HTMLInputElement>(null);

  // Create errors belong to the username field: announce them, expose the
  // relationship on the input, and return focus there.
  function failCreate(message: string) {
    setCreateError(message);
    usernameRef.current?.focus();
  }

  // In-flight idempotent attempts: the opaque request id and the
  // client-generated candidate password are retained across retries so a
  // lost response can be reconciled truthfully — the server applies each
  // request id at most once and never returns the plaintext.
  const createAttemptRef = useRef<{
    requestId: string;
    password: string;
  } | null>(null);
  const resetAttemptRef = useRef<{
    userId: string;
    requestId: string;
    password: string;
  } | null>(null);

  // Definitive server rejections (4xx) mean this request id never
  // committed; ambiguous transport/5xx failures keep the attempt alive.
  function isDefinitiveRejection(error: unknown): boolean {
    return isApiError(error) && error.status < 500;
  }

  const { begin } = useLatest();

  const load = useCallback(async () => {
    const ticket = begin();
    setState({ kind: "loading" });
    try {
      const { users } = await apiFetch<{ users: PublicUser[] }>("/api/users", {
        signal: ticket.signal,
      });
      if (!ticket.current()) return;
      setState({ kind: "ready", users });
    } catch {
      if (!ticket.current()) return;
      setState({ kind: "error" });
    }
  }, [begin]);

  useEffect(() => {
    void load();
  }, [load]);

  const users = useMemo(
    () => (state.kind === "ready" ? state.users : []),
    [state],
  );
  const activeAdmins = users.filter(
    (user) => user.role === "admin" && user.active,
  );
  const lastAdminId = activeAdmins.length === 1 ? activeAdmins[0]!.id : null;
  const selected = users.find((user) => user.id === selectedId) ?? null;

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("en-US");
    return users.filter((user) => {
      if (roleFilter !== "all" && user.role !== roleFilter) return false;
      if (statusFilter === "active" && !user.active) return false;
      if (statusFilter === "disabled" && user.active) return false;
      if (query && !user.username.includes(query)) return false;
      return true;
    });
  }, [users, search, roleFilter, statusFilter]);

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    try {
      setBusy(true);
      setCreateError(null);
      const attempt = createAttemptRef.current ?? {
        requestId: newRequestId(),
        password: generateTempPassword(),
      };
      createAttemptRef.current = attempt;
      const create = () =>
        apiFetch<{ user: PublicUser }>("/api/users", {
          method: "POST",
          body: {
            username: createUsername.trim(),
            password: attempt.password,
            role: createRole,
            request_id: attempt.requestId,
          },
        });
      let result: { user: PublicUser };
      try {
        result = await create();
      } catch (error) {
        if (isDefinitiveRejection(error)) throw error;
        // The request may have committed and only the response was lost.
        // The same request id reconciles to the same user — never a
        // duplicate — so the retained candidate password stays truthful.
        result = await create();
      }
      createAttemptRef.current = null;
      setCreateOpen(false);
      setCreateUsername("");
      setCreateRole("member");
      setSecret({
        kind: "created",
        username: result.user.username,
        password: attempt.password,
      });
      void load();
    } catch (error) {
      if (error instanceof RequestIdUnavailableError) {
        createAttemptRef.current = null;
        failCreate(error.message);
      } else if (isApiError(error) && error.code === "username_exists") {
        createAttemptRef.current = null;
        failCreate("That username is already taken.");
      } else if (isApiError(error) && error.code === "request_id_conflict") {
        createAttemptRef.current = null;
        failCreate(
          "Another user was created. Directory reloaded — start again.",
        );
        void load();
      } else if (isDefinitiveRejection(error)) {
        createAttemptRef.current = null;
        failCreate(`${error instanceof Error ? error.message : "Rejected"}.`);
      } else {
        // Ambiguous: keep the attempt so a manual retry reconciles with
        // the same request id and candidate password.
        failCreate(
          "No confirmation. The user may or may not have been created. Retry or reload to check.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  // Desired-state mutation with truthful ambiguity handling: when the
  // transport fails after the server may have committed, the authoritative
  // record decides — reconciled success if the desired state is present,
  // an explicit unknown outcome otherwise. Never "nothing was changed".
  async function patchDesiredState(
    userId: string,
    body: Record<string, unknown>,
    isDesired: (user: PublicUser) => boolean,
  ): Promise<boolean> {
    try {
      await apiFetch(`/api/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body,
      });
      return false;
    } catch (error) {
      if (isDefinitiveRejection(error)) throw error;
      let verified: PublicUser | undefined;
      try {
        const { users } = await apiFetch<{ users: PublicUser[] }>("/api/users");
        verified = users.find((user) => user.id === userId);
      } catch {
        verified = undefined;
      }
      if (!verified || !isDesired(verified)) throw error;
      // The desired state is confirmed on the server — reconciled.
      return true;
    }
  }

  async function runConfirm() {
    if (!confirm || busy) return;
    const target = confirm.user;
    try {
      setBusy(true);
      setConfirmError(null);
      setReconcileNotice(null);
      if (confirm.kind === "disable" || confirm.kind === "enable") {
        const active = confirm.kind === "enable";
        await patchDesiredState(
          target.id,
          { active },
          (user) => user.active === active,
        );
        setReconcileNotice(active ? "Account enabled." : "Account disabled.");
      } else if (confirm.kind === "role") {
        const nextRole = confirm.nextRole;
        await patchDesiredState(
          target.id,
          { role: nextRole },
          (user) => user.role === nextRole,
        );
        setReconcileNotice("Role changed.");
      } else {
        const attempt =
          resetAttemptRef.current?.userId === target.id
            ? resetAttemptRef.current
            : {
                userId: target.id,
                requestId: newRequestId(),
                password: generateTempPassword(),
              };
        resetAttemptRef.current = attempt;
        const reset = () =>
          apiFetch(`/api/users/${encodeURIComponent(target.id)}`, {
            method: "PATCH",
            body: { password: attempt.password, request_id: attempt.requestId },
          });
        try {
          await reset();
        } catch (error) {
          if (isDefinitiveRejection(error)) throw error;
          // The reset may have committed with a lost response. The same
          // request id applies the candidate at most once, so this retry
          // can never set a second unseen password.
          await reset();
        }
        resetAttemptRef.current = null;
        setSecret({
          kind: "reset",
          username: target.username,
          password: attempt.password,
        });
      }
      setConfirm(null);
      void load();
    } catch (error) {
      if (error instanceof RequestIdUnavailableError) {
        if (confirm.kind === "reset") resetAttemptRef.current = null;
        setConfirmError(error.message);
      } else if (isApiError(error) && error.code === "last_active_admin") {
        setConfirm(null);
        setConflict({
          verb: confirm.kind === "role" ? "demote" : "disable",
          username: target.username,
        });
      } else if (isApiError(error) && error.status === 404) {
        if (confirm.kind === "reset") resetAttemptRef.current = null;
        setConfirmError("User not found — reload the directory.");
      } else if (isDefinitiveRejection(error)) {
        if (confirm.kind === "reset") resetAttemptRef.current = null;
        setConfirmError(
          `${error instanceof Error ? error.message : "Rejected"}.`,
        );
      } else if (confirm.kind === "reset") {
        setConfirmError(
          "No confirmation. The password may or may not have changed. Retry or reload to check.",
        );
      } else {
        setConfirmError(
          "The change may or may not have applied. Refresh or retry.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="User directory">
      {state.kind === "ready" ? (
        <p className="page-statline">
          {users.length} accounts · {users.filter((user) => user.active).length}{" "}
          active · {users.filter((user) => user.role === "admin").length} admin
        </p>
      ) : null}
      {reconcileNotice ? (
        <p className="notice notice-success" role="status">
          {reconcileNotice}
        </p>
      ) : null}
      <div className="toolbar">
        <input
          id={searchId}
          type="search"
          className="toolbar-search"
          placeholder="Search"
          aria-label="Search username"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="segment" role="group" aria-label="Role filter">
          {(["all", "admin", "member"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`segment-item${roleFilter === value ? " segment-item-active" : ""}`}
              aria-pressed={roleFilter === value}
              onClick={() => setRoleFilter(value)}
            >
              {value === "all"
                ? "All roles"
                : value === "admin"
                  ? "Admin"
                  : "Member"}
            </button>
          ))}
        </div>
        <div className="segment" role="group" aria-label="Status filter">
          {(["all", "active", "disabled"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`segment-item${statusFilter === value ? " segment-item-active" : ""}`}
              aria-pressed={statusFilter === value}
              onClick={() => setStatusFilter(value)}
            >
              {value === "all"
                ? "All status"
                : value === "active"
                  ? "Active"
                  : "Disabled"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            setCreateError(null);
            createAttemptRef.current = null;
            setCreateOpen(true);
          }}
        >
          New user
        </button>
      </div>

      {state.kind === "loading" ? (
        <div className="table-fallback">
          <div className="skeleton-row" aria-hidden="true" />
          <div className="skeleton-row" aria-hidden="true" />
          <p className="muted" role="status">
            Loading…
          </p>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="table-fallback" role="alert">
          <p className="error-title">Couldn&apos;t load users</p>
          <button type="button" className="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <>
          <table className="data-table data-table-selectable">
            <thead>
              <tr>
                <th scope="col">Username</th>
                <th scope="col" className="col-desktop">
                  Role
                </th>
                <th scope="col" className="col-desktop">
                  Status
                </th>
                <th scope="col" className="col-desktop">
                  Files
                </th>
                <th scope="col" className="col-desktop">
                  Keys
                </th>
                <th scope="col" className="col-desktop">
                  Last active
                </th>
                <th scope="col" className="col-desktop">
                  Created
                </th>
                <th scope="col" className="col-actions">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((user) => {
                const isYou = user.id === viewer.id;
                const isLastAdmin = user.id === lastAdminId;
                return (
                  <tr
                    key={user.id}
                    className={[
                      user.active ? "" : "row-muted",
                      user.id === selectedId ? "row-selected" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <td className="cell-strong">
                      <button
                        type="button"
                        className="row-open"
                        onClick={() =>
                          setSelectedId(selectedId === user.id ? null : user.id)
                        }
                      >
                        {user.username}
                        {isYou ? <span className="muted"> · you</span> : null}
                        <span className="row-sub" aria-hidden="true">
                          {user.role} · {user.active ? "active" : "disabled"}
                          {isLastAdmin ? " · last admin" : ""} ·{" "}
                          {formatMobileLastActive(user.last_active_at ?? null)}
                        </span>
                      </button>
                    </td>
                    <td className="cell-mono col-desktop">{user.role}</td>
                    <td className="cell-mono col-desktop">
                      {user.active ? "active" : "disabled"}
                      {isLastAdmin ? (
                        <span className="muted"> · last admin</span>
                      ) : null}
                    </td>
                    <td className="cell-mono cell-num col-desktop">
                      {user.files_count ?? 0}
                    </td>
                    <td className="cell-mono cell-num col-desktop">
                      {user.api_keys_count ?? 0}
                    </td>
                    <td className="cell-mono cell-num col-desktop">
                      {user.last_active_at
                        ? formatDate(user.last_active_at)
                        : "never"}
                    </td>
                    <td className="cell-mono cell-num col-desktop">
                      {formatDate(user.created_at)}
                    </td>
                    <td className="col-actions">
                      {!isLastAdmin ? (
                        <button
                          type="button"
                          className="link-button row-overflow"
                          aria-label={`Actions for ${user.username}`}
                          onClick={() => setSheetUser(user)}
                        >
                          ⋯
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="link-button col-desktop-inline"
                        onClick={() => {
                          setConfirmError(null);
                          setConfirm({ kind: "reset", user });
                        }}
                      >
                        Reset
                        <span className="visually-hidden">
                          {" "}
                          password for {user.username}
                        </span>
                      </button>
                      <span className="col-desktop-inline">{" · "}</span>
                      {isLastAdmin ? (
                        <span className="muted">protected</span>
                      ) : user.active ? (
                        <button
                          type="button"
                          className="link-button col-desktop-inline"
                          onClick={() => {
                            setConfirmError(null);
                            setConfirm({ kind: "disable", user });
                          }}
                        >
                          Disable
                          <span className="visually-hidden">
                            {" "}
                            {user.username}
                          </span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="link-button col-desktop-inline"
                          onClick={() => {
                            setConfirmError(null);
                            setConfirm({ kind: "enable", user });
                          }}
                        >
                          Enable
                          <span className="visually-hidden">
                            {" "}
                            {user.username}
                          </span>
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={8} className="table-empty">
                    <p>No accounts match.</p>
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setSearch("");
                        setRoleFilter("all");
                        setStatusFilter("all");
                      }}
                    >
                      Clear filters
                    </button>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </>
      ) : null}

      {selected ? (
        <div className="detail-split">
          <section
            className="detail-facts"
            aria-label={`${selected.username} detail`}
          >
            <h2 className="detail-title">{selected.username}</h2>
            <dl className="fact-list">
              <div className="fact-row">
                <dt>role</dt>
                <dd>{selected.role}</dd>
              </div>
              <div className="fact-row">
                <dt>status</dt>
                <dd>
                  {selected.active ? "active" : "disabled"}
                  {selected.id === lastAdminId ? " · last admin" : ""}
                </dd>
              </div>
              <div className="fact-row">
                <dt>password last changed</dt>
                <dd>
                  {formatDate(
                    selected.password_changed_at ?? selected.updated_at,
                  )}
                </dd>
              </div>
              <div className="fact-row">
                <dt>active sessions</dt>
                <dd>{selected.sessions_count ?? 0}</dd>
              </div>
              <div className="fact-row">
                <dt>files</dt>
                <dd>{selected.files_count ?? 0}</dd>
              </div>
              <div className="fact-row">
                <dt>API keys</dt>
                <dd>{selected.api_keys_count ?? 0}</dd>
              </div>
            </dl>
          </section>
          <section className="detail-actions" aria-label="Admin actions">
            <h2 className="section-label">Admin actions</h2>
            <button
              type="button"
              className="button button-block"
              onClick={() => {
                setConfirmError(null);
                setConfirm({
                  kind: "role",
                  user: selected,
                  nextRole: selected.role === "admin" ? "member" : "admin",
                });
              }}
            >
              Change role…
            </button>
            <button
              type="button"
              className="button button-block"
              onClick={() => {
                setConfirmError(null);
                setConfirm({ kind: "reset", user: selected });
              }}
            >
              Reset password…
            </button>
            {selected.id === lastAdminId ? (
              <p className="muted">last admin · protected — cannot disable</p>
            ) : selected.active ? (
              <button
                type="button"
                className="button button-block button-danger-outline"
                onClick={() => {
                  setConfirmError(null);
                  setConfirm({ kind: "disable", user: selected });
                }}
              >
                Disable account…
              </button>
            ) : (
              <button
                type="button"
                className="button button-block"
                onClick={() => {
                  setConfirmError(null);
                  setConfirm({ kind: "enable", user: selected });
                }}
              >
                Enable account…
              </button>
            )}
          </section>
        </div>
      ) : null}

      {createOpen ? (
        <Dialog
          title="New user"
          busy={busy}
          onClose={() => setCreateOpen(false)}
        >
          <form onSubmit={submitCreate} noValidate>
            <div className="field">
              <label htmlFor={usernameId}>Username</label>
              <input
                ref={usernameRef}
                id={usernameId}
                type="text"
                autoCapitalize="none"
                spellCheck={false}
                value={createUsername}
                aria-invalid={createError ? true : undefined}
                aria-describedby={createError ? usernameErrorId : undefined}
                onChange={(event) => {
                  setCreateUsername(event.target.value);
                  setCreateError(null);
                  // Edited intent = a new operation; drop the old attempt.
                  createAttemptRef.current = null;
                }}
              />
              <p className="field-hint">a–z 0–9 . - _ · 3–64 chars · unique</p>
              {createError ? (
                <p id={usernameErrorId} className="field-error" role="alert">
                  {createError}
                </p>
              ) : null}
            </div>
            <fieldset className="field radio-group">
              <legend>Role</legend>
              <label className="radio-row">
                <input
                  type="radio"
                  name="role"
                  checked={createRole === "member"}
                  onChange={() => {
                    setCreateRole("member");
                    createAttemptRef.current = null;
                  }}
                />
                Member
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  name="role"
                  checked={createRole === "admin"}
                  onChange={() => {
                    setCreateRole("admin");
                    createAttemptRef.current = null;
                  }}
                />
                Admin — full control of files, users, keys
              </label>
            </fieldset>
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button button-primary"
                disabled={busy}
              >
                {busy ? "Creating…" : "Create user"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {sheetUser ? (
        <Dialog title={sheetUser.username} onClose={() => setSheetUser(null)}>
          <p className="muted">
            {sheetUser.role} · {sheetUser.active ? "active" : "disabled"} ·{" "}
            {formatDate(sheetUser.created_at)}
          </p>
          <div className="sheet-actions">
            <button
              type="button"
              className="button button-block"
              onClick={() => {
                setSheetUser(null);
                setConfirmError(null);
                setConfirm({
                  kind: "role",
                  user: sheetUser,
                  nextRole: sheetUser.role === "admin" ? "member" : "admin",
                });
              }}
            >
              Change role to {sheetUser.role === "admin" ? "member" : "admin"}…
            </button>
            <button
              type="button"
              className="button button-block"
              onClick={() => {
                setSheetUser(null);
                setConfirmError(null);
                setConfirm({ kind: "reset", user: sheetUser });
              }}
            >
              Reset password…
            </button>
            {sheetUser.id === lastAdminId ? (
              <p className="muted">last admin · protected — cannot disable</p>
            ) : sheetUser.active ? (
              <button
                type="button"
                className="button button-block button-danger-outline"
                onClick={() => {
                  setSheetUser(null);
                  setConfirmError(null);
                  setConfirm({ kind: "disable", user: sheetUser });
                }}
              >
                Disable account…
              </button>
            ) : (
              <button
                type="button"
                className="button button-block"
                onClick={() => {
                  setSheetUser(null);
                  setConfirmError(null);
                  setConfirm({ kind: "enable", user: sheetUser });
                }}
              >
                Enable account…
              </button>
            )}
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              onClick={() => setSheetUser(null)}
            >
              Close
            </button>
          </div>
        </Dialog>
      ) : null}

      {confirm?.kind === "disable" ? (
        <Dialog
          title={`Disable ${confirm.user.username}?`}
          tone="danger"
          busy={busy}
          onClose={() => setConfirm(null)}
        >
          <p>
            Sessions and API keys stop immediately. Files stay. Re-enable any
            time.
          </p>
          {confirmError ? (
            <p className="field-error" role="alert">
              {confirmError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={busy}
              onClick={() => void runConfirm()}
            >
              {busy ? "Disabling…" : "Disable account"}
            </button>
          </div>
        </Dialog>
      ) : null}

      {confirm?.kind === "enable" ? (
        <Dialog
          title={`Enable ${confirm.user.username}?`}
          busy={busy}
          onClose={() => setConfirm(null)}
        >
          <p>Sign-in and API keys resume. Revoked sessions stay signed out.</p>
          {confirmError ? (
            <p className="field-error" role="alert">
              {confirmError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => void runConfirm()}
            >
              {busy ? "Enabling…" : "Enable account"}
            </button>
          </div>
        </Dialog>
      ) : null}

      {confirm?.kind === "role" ? (
        <Dialog
          title={`Make ${confirm.user.username} ${confirm.nextRole === "admin" ? "an admin" : "a member"}?`}
          busy={busy}
          onClose={() => setConfirm(null)}
        >
          {confirm.nextRole === "admin" ? (
            <p>Full control of every file, user and key.</p>
          ) : (
            <p>Own files, keys and password.</p>
          )}
          {confirmError ? (
            <p className="field-error" role="alert">
              {confirmError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => void runConfirm()}
            >
              {busy ? "Changing…" : "Change role"}
            </button>
          </div>
        </Dialog>
      ) : null}

      {confirm?.kind === "reset" ? (
        <Dialog
          title={`Reset password for ${confirm.user.username}?`}
          busy={busy}
          onClose={() => setConfirm(null)}
        >
          <p>Current password and sessions end. New password shown once.</p>
          {confirmError ? (
            <p className="field-error" role="alert">
              {confirmError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => void runConfirm()}
            >
              {busy ? "Resetting…" : "Reset password"}
            </button>
          </div>
        </Dialog>
      ) : null}

      {conflict ? (
        <Dialog
          title={`Can't ${conflict.verb} ${conflict.username}`}
          titleAdornment={<span className="tag tag-danger">409</span>}
          onClose={() => setConflict(null)}
        >
          <p>{conflict.username} is the last active admin.</p>
          <p>Promote another admin first.</p>
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                // Escape hatch: land on the member list so another admin
                // can be promoted immediately.
                setConflict(null);
                setRoleFilter("member");
                setSelectedId(null);
              }}
            >
              View members
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={() => setConflict(null)}
            >
              OK
            </button>
          </div>
        </Dialog>
      ) : null}

      {secret ? (
        <SecretOnceDialog
          title={
            secret.kind === "created"
              ? `User created — ${secret.username}`
              : `Password reset — ${secret.username}`
          }
          tag={secret.kind === "created" ? "CREATED" : "RESET"}
          intro="Copy now. You won’t see it again. Expires in 7 days if unused."
          secret={secret.password}
          acknowledgement="I've shared or stored this password."
          onDone={() => setSecret(null)}
        />
      ) : null}
    </section>
  );
}
