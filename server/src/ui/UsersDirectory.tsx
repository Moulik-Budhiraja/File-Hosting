"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";

import Link from "next/link";

import { apiFetch, isApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useLatest } from "@/lib/use-latest";
import { formatDate } from "@/lib/format";
import { generateTempPassword } from "@/lib/password";
import type { PublicUser, Role } from "@/lib/types";
import { Dialog } from "./Dialog";
import { SecretOnceDialog } from "./SecretOnceDialog";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; status: number }
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
  const searchId = useId();
  const usernameId = useId();

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
    } catch (error) {
      if (!ticket.current()) return;
      setState({ kind: "error", status: isApiError(error) ? error.status : 0 });
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
    setBusy(true);
    setCreateError(null);
    const password = generateTempPassword();
    try {
      const { user } = await apiFetch<{ user: PublicUser }>("/api/users", {
        method: "POST",
        body: { username: createUsername.trim(), password, role: createRole },
      });
      setCreateOpen(false);
      setCreateUsername("");
      setCreateRole("member");
      setSecret({ kind: "created", username: user.username, password });
      void load();
    } catch (error) {
      if (isApiError(error) && error.code === "username_exists") {
        setCreateError("That username is already taken.");
      } else if (isApiError(error)) {
        setCreateError(`${error.message}.`);
      } else {
        setCreateError(
          "The server couldn't create the user. Nothing was changed.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function runConfirm() {
    if (!confirm || busy) return;
    setBusy(true);
    setConfirmError(null);
    const target = confirm.user;
    try {
      if (confirm.kind === "disable" || confirm.kind === "enable") {
        await apiFetch(`/api/users/${encodeURIComponent(target.id)}`, {
          method: "PATCH",
          body: { active: confirm.kind === "enable" },
        });
      } else if (confirm.kind === "role") {
        await apiFetch(`/api/users/${encodeURIComponent(target.id)}`, {
          method: "PATCH",
          body: { role: confirm.nextRole },
        });
      } else {
        const password = generateTempPassword();
        await apiFetch(`/api/users/${encodeURIComponent(target.id)}`, {
          method: "PATCH",
          body: { password },
        });
        setSecret({ kind: "reset", username: target.username, password });
      }
      setConfirm(null);
      void load();
    } catch (error) {
      if (isApiError(error) && error.code === "last_active_admin") {
        setConfirm(null);
        setConflict({
          verb: confirm.kind === "role" ? "demote" : "disable",
          username: target.username,
        });
      } else if (isApiError(error) && error.status === 404) {
        setConfirmError("User not found — reload the directory.");
      } else {
        setConfirmError(
          "The server couldn't complete the request. Nothing was changed.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="User directory">
      <p className="page-statline">
        {users.length} accounts · {users.filter((user) => user.active).length}{" "}
        active · {users.filter((user) => user.role === "admin").length} admin ·
        bcrypt password storage
      </p>
      <div className="toolbar">
        <input
          id={searchId}
          type="search"
          className="toolbar-search"
          placeholder="search username"
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
        <span className="toolbar-note">
          sessions expire 7 days after sign-in
        </span>
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            setCreateError(null);
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
            loading users…
          </p>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="table-fallback" role="alert">
          <p className="error-title">Couldn&apos;t load users</p>
          <p className="muted">
            GET /api/users → {state.status || "network"} · nothing was changed
          </p>
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
                  Created
                </th>
                <th scope="col" className="col-desktop">
                  Updated
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
                          {user.role} · {user.active ? "active" : "disabled"} ·{" "}
                          {formatDate(user.created_at)}
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
                      {formatDate(user.created_at)}
                    </td>
                    <td className="cell-mono cell-num col-desktop">
                      {formatDate(user.updated_at)}
                    </td>
                    <td className="col-actions">
                      <button
                        type="button"
                        className="link-button row-overflow"
                        aria-label={`Actions for ${user.username}`}
                        onClick={() => setSheetUser(user)}
                      >
                        ⋯
                      </button>
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
                        <span className="muted col-desktop-inline">
                          last admin · protected
                        </span>
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
                  <td colSpan={6} className="muted">
                    no accounts match the current filters
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="table-footline">
            rows 1–{visible.length} of {users.length} · all accounts loaded
          </p>
        </>
      ) : null}

      {selected ? (
        <div className="detail-split">
          <section
            className="detail-facts"
            aria-label={`${selected.username} detail`}
          >
            <h2 className="detail-title">
              {selected.username}{" "}
              <span className="muted">users / {selected.username}</span>
            </h2>
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
                <dt>password</dt>
                <dd>bcrypt hash set · never displayed</dd>
              </div>
              <div className="fact-row">
                <dt>created</dt>
                <dd>{formatDate(selected.created_at)}</dd>
              </div>
              <div className="fact-row">
                <dt>updated</dt>
                <dd>{formatDate(selected.updated_at)}</dd>
              </div>
              <div className="fact-row">
                <dt>api keys</dt>
                <dd>
                  <Link href="/keys">open in API Keys →</Link>
                </dd>
              </div>
              <div className="fact-row">
                <dt>files</dt>
                <dd>
                  <Link href="/files">open in Files →</Link>
                </dd>
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
            {selected.active ? (
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
            <p className="muted">
              every action here opens an explicit confirmation · nothing fires
              on first click
            </p>
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
                id={usernameId}
                type="text"
                autoCapitalize="none"
                spellCheck={false}
                value={createUsername}
                onChange={(event) => setCreateUsername(event.target.value)}
              />
              <p className="field-hint">a–z 0–9 . - _ · 3–64 chars · unique</p>
              {createError ? (
                <p className="field-error" role="alert">
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
                  onChange={() => setCreateRole("member")}
                />
                Member — manages own files, own API keys, own password
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  name="role"
                  checked={createRole === "admin"}
                  onChange={() => setCreateRole("admin")}
                />
                Admin — full control of files, users and keys
              </label>
            </fieldset>
            <p className="muted">
              A one-time temporary password is generated on create and shown
              exactly once. Share it over a secure channel.
            </p>
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
            {confirm.user.username} will no longer be able to sign in. This
            happens immediately:
          </p>
          <ul className="consequence-list">
            <li>active sessions are signed out</li>
            <li>API keys stop working (kept, not deleted)</li>
            <li>files stay in place — admins can still manage them</li>
          </ul>
          <p>You can re-enable this account at any time.</p>
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
          <p>
            {confirm.user.username} will be able to sign in again with their
            existing password. Previously revoked sessions stay signed out;
            their API keys start working again.
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
            <p>
              Admins have full control: every file, every user, every API key,
              and the legacy service token status.
            </p>
          ) : (
            <p>
              {confirm.user.username} will manage only their own files, API
              keys, and password. Admin surfaces disappear on their next
              request.
            </p>
          )}
          <p className="muted">
            {confirm.user.role} → {confirm.nextRole} · takes effect on next
            request
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
          <p>
            {confirm.user.username}&apos;s current password stops working and
            their sessions are signed out. A new one-time temporary password
            will be shown to you exactly once.
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
          titleAdornment={
            <span className="tag tag-danger">409 · LAST ACTIVE ADMIN</span>
          }
          onClose={() => setConflict(null)}
        >
          <p>
            {conflict.username} is the only active admin. Disabling or demoting
            this account would lock everyone out of user management — the server
            refused the change and nothing was modified.
          </p>
          <p>Promote another member to admin first, then retry.</p>
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
          intro="Temporary password — shown only this once. Share it over a secure channel."
          secret={secret.password}
          acknowledgement="I've shared or stored this password — it won't be shown again."
          footnote={
            secret.kind === "created"
              ? "no email flow — this server has usernames only; the admin hands the password over"
              : "their old password and sessions stopped working the moment you confirmed"
          }
          onDone={() => setSecret(null)}
        />
      ) : null}
    </section>
  );
}
