"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { apiFetch, isApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useLatest } from "@/lib/use-latest";
import { formatDate, formatDateTime } from "@/lib/format";
import type { ApiKeyMetadata } from "@/lib/types";
import { Dialog } from "./Dialog";

interface KeyRow extends ApiKeyMetadata {
  ownerName: string | null;
}

interface AggregateKey extends ApiKeyMetadata {
  owner_username: string;
}

const AGGREGATE_PAGE_LIMIT = 100;

type ListState =
  | { kind: "loading" }
  | { kind: "error"; status: number }
  | { kind: "ready"; keys: KeyRow[]; nextCursor: string | null };

interface SecretState {
  name: string;
  secret: string;
  acked: boolean;
  copied: boolean;
  copyFailed: boolean;
  closeWarned: boolean;
}

export function maskKey(prefix: string, lastFour: string): string {
  return `${prefix.slice(0, 8)} ···· ${lastFour}`;
}

export function ApiKeysView() {
  const { user, isAdmin } = useAuth();
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | "mine">(isAdmin ? "all" : "mine");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<SecretState | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<KeyRow | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [prevCursors, setPrevCursors] = useState<Array<string | null>>([]);
  const nameId = useId();

  const { begin } = useLatest();

  const load = useCallback(async () => {
    const ticket = begin();
    setState({ kind: "loading" });
    try {
      if (isAdmin && scope === "all") {
        // One paginated aggregate request with owner identity — never an
        // O(users) fan-out.
        const params = new URLSearchParams();
        params.set("scope", "all");
        params.set("limit", String(AGGREGATE_PAGE_LIMIT));
        if (cursor) params.set("cursor", cursor);
        const page = await apiFetch<{
          api_keys: AggregateKey[];
          next_cursor: string | null;
        }>(`/api/api-keys?${params.toString()}`, { signal: ticket.signal });
        if (!ticket.current()) return;
        setState({
          kind: "ready",
          keys: page.api_keys.map((key) => ({
            ...key,
            ownerName: key.owner_username,
          })),
          nextCursor: page.next_cursor,
        });
      } else {
        const { api_keys } = await apiFetch<{ api_keys: ApiKeyMetadata[] }>(
          "/api/api-keys",
          { signal: ticket.signal },
        );
        if (!ticket.current()) return;
        setState({
          kind: "ready",
          keys: api_keys.map((key) => ({ ...key, ownerName: user.username })),
          nextCursor: null,
        });
      }
    } catch (error) {
      if (!ticket.current()) return;
      setState({
        kind: "error",
        status: isApiError(error) ? error.status : 0,
      });
    }
  }, [begin, isAdmin, scope, cursor, user.username]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (state.kind !== "ready") return [];
    const query = search.trim().toLocaleLowerCase("en-US");
    return state.keys.filter(
      (key) => !query || key.name.toLocaleLowerCase("en-US").includes(query),
    );
  }, [state, search]);

  const activeCount =
    state.kind === "ready"
      ? state.keys.filter((key) => !key.revoked_at).length
      : 0;

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    if (creating) return;
    const name = createName.trim();
    if (!name) {
      setCreateError("Name the machine or job this key is for.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const created = await apiFetch<{
        api_key: { id: string; secret: string };
      }>("/api/api-keys", { method: "POST", body: { name } });
      setCreateOpen(false);
      setCreateName("");
      setSecret({
        name,
        secret: created.api_key.secret,
        acked: false,
        copied: false,
        copyFailed: false,
        closeWarned: false,
      });
      void load();
    } catch (error) {
      setCreateError(
        isApiError(error)
          ? `${error.message}.`
          : "The server couldn't create the key. Nothing was changed.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.secret);
      setSecret({ ...secret, copied: true, copyFailed: false });
    } catch {
      setSecret({ ...secret, copyFailed: true });
    }
  }

  function closeSecret() {
    if (!secret) return;
    if (!secret.acked && !secret.closeWarned) {
      setSecret({ ...secret, closeWarned: true });
      return;
    }
    setSecret(null);
  }

  async function confirmRevoke() {
    if (!revokeTarget || revoking) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      await apiFetch(`/api/api-keys/${encodeURIComponent(revokeTarget.id)}`, {
        method: "DELETE",
      });
      setRevokeTarget(null);
      void load();
    } catch (error) {
      setRevokeError(
        isApiError(error) && error.status === 404
          ? "API key not found — it may already be revoked."
          : "The server couldn't revoke the key. It is still active.",
      );
    } finally {
      setRevoking(false);
    }
  }

  return (
    <section aria-label="API keys">
      <div className="toolbar">
        <input
          type="search"
          className="toolbar-search"
          placeholder="search key name"
          aria-label="Search key name"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {isAdmin ? (
          <div className="segment" role="group" aria-label="Key owner filter">
            <button
              type="button"
              className={`segment-item${scope === "all" ? " segment-item-active" : ""}`}
              aria-pressed={scope === "all"}
              onClick={() => {
                setCursor(null);
                setPrevCursors([]);
                setScope("all");
              }}
            >
              All users
            </button>
            <button
              type="button"
              className={`segment-item${scope === "mine" ? " segment-item-active" : ""}`}
              aria-pressed={scope === "mine"}
              onClick={() => {
                setCursor(null);
                setPrevCursors([]);
                setScope("mine");
              }}
            >
              Mine
            </button>
          </div>
        ) : null}
        <span className="toolbar-note">CLI: Authorization: Bearer fsk_…</span>
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            setCreateError(null);
            setCreateOpen(true);
          }}
        >
          New key
        </button>
      </div>

      {state.kind === "loading" ? (
        <div className="table-fallback">
          <div className="skeleton-row" aria-hidden="true" />
          <div className="skeleton-row" aria-hidden="true" />
          <p className="muted" role="status">
            loading keys…
          </p>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="table-fallback" role="alert">
          <p className="error-title">Couldn&apos;t load keys</p>
          <p className="muted">
            GET /api/api-keys → {state.status || "network"} · nothing was
            changed
          </p>
          <button type="button" className="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === "ready" && state.keys.length === 0 ? (
        <div className="table-fallback">
          <p className="empty-title">No API keys yet</p>
          <p className="muted">
            Keys let the fs CLI act as you without your password. Create one,
            then run fs auth set on that machine.
          </p>
          <button
            type="button"
            className="button button-primary"
            onClick={() => setCreateOpen(true)}
          >
            New key
          </button>
        </div>
      ) : null}

      {state.kind === "ready" && state.keys.length > 0 ? (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                {isAdmin ? (
                  <th scope="col" className="col-desktop">
                    Owner
                  </th>
                ) : null}
                <th scope="col" className="col-desktop">
                  Key
                </th>
                <th scope="col" className="col-desktop">
                  Created
                </th>
                <th scope="col" className="col-desktop">
                  Last used
                </th>
                <th scope="col" className="col-desktop">
                  Status
                </th>
                <th scope="col" className="col-actions">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((key) => (
                <tr
                  key={key.id}
                  className={key.revoked_at ? "row-muted" : undefined}
                >
                  <td className="cell-strong">
                    {key.name}
                    <span className="row-sub" aria-hidden="true">
                      {maskKey(key.prefix, key.last_four)} ·{" "}
                      {key.revoked_at ? "revoked" : "active"}
                    </span>
                  </td>
                  {isAdmin ? (
                    <td className="cell-mono col-desktop">{key.ownerName}</td>
                  ) : null}
                  <td className="cell-mono col-desktop">
                    {maskKey(key.prefix, key.last_four)}
                  </td>
                  <td className="cell-mono cell-num col-desktop">
                    {formatDate(key.created_at)}
                  </td>
                  <td className="cell-mono cell-num col-desktop">
                    {formatDateTime(key.last_used_at)}
                  </td>
                  <td className="cell-mono col-desktop">
                    {key.revoked_at
                      ? `revoked · ${formatDate(key.revoked_at)}`
                      : "active"}
                  </td>
                  <td className="col-actions">
                    {key.revoked_at ? (
                      <span aria-hidden="true">—</span>
                    ) : (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          setRevokeError(null);
                          setRevokeTarget(key);
                        }}
                      >
                        Revoke
                        <span className="visually-hidden"> {key.name}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 7 : 6} className="muted">
                    no keys match the current filters
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div className="table-footline table-footline-split">
            <span>
              {state.keys.length} {state.keys.length === 1 ? "key" : "keys"} ·{" "}
              {activeCount} active · recent revoked keys stay listed — records
              older than 90 days or beyond the last 20 may be pruned
            </span>
            {isAdmin && scope === "all" ? (
              <span className="pager">
                <button
                  type="button"
                  className="button button-small"
                  disabled={prevCursors.length === 0}
                  onClick={() => {
                    const previous = [...prevCursors];
                    const target = previous.pop() ?? null;
                    setPrevCursors(previous);
                    setCursor(target);
                  }}
                >
                  ← prev
                </button>
                <button
                  type="button"
                  className="button button-small"
                  disabled={state.nextCursor === null}
                  onClick={() => {
                    setPrevCursors([...prevCursors, cursor]);
                    setCursor(state.nextCursor);
                  }}
                >
                  next →
                </button>
              </span>
            ) : null}
          </div>
        </>
      ) : null}

      {isAdmin ? (
        <section className="legacy-token" aria-label="Legacy service token">
          <h2 className="section-label">Legacy service token</h2>
          <p className="muted">
            Shared FS_TOKEN bearer credential · still accepted on /api/* · value
            never shown. Replace CLI use with personal keys (fs auth set).
          </p>
        </section>
      ) : null}

      {createOpen ? (
        <Dialog
          title="New API key"
          busy={creating}
          onClose={() => setCreateOpen(false)}
        >
          <form onSubmit={submitCreate} noValidate>
            <div className="field">
              <label htmlFor={nameId}>Name — where will this key live?</label>
              <input
                id={nameId}
                type="text"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
              />
              <p className="field-hint">
                e.g. laptop-mbp · ci-runner · ingest-pipeline — one key per
                machine or job
              </p>
              {createError ? (
                <p className="field-error" role="alert">
                  {createError}
                </p>
              ) : null}
            </div>
            <p className="muted">
              The key acts as you ({user.username}) with your permissions. You
              can revoke it at any time.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                disabled={creating}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button button-primary"
                disabled={creating}
              >
                {creating ? "Creating…" : "Create key"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {secret ? (
        <Dialog
          title={`Key created — ${secret.name}`}
          titleAdornment={
            <span className="tag tag-warning">SHOWN ONLY ONCE</span>
          }
          onClose={closeSecret}
        >
          <p>
            This is the only time the full key is shown. If you lose it, revoke
            it and create a new one.
          </p>
          <div className="secret-block">
            <code className="secret-value">{secret.secret}</code>
            <button
              type="button"
              className={`button${secret.copied ? " button-confirmed" : ""}`}
              onClick={() => void copySecret()}
            >
              {secret.copied ? "copied ✓" : "Copy"}
            </button>
          </div>
          {secret.copyFailed ? (
            <p className="field-error" role="alert">
              Copy failed — select the key text and copy it manually.
            </p>
          ) : null}
          <p className="muted use-it">
            USE IT · $ fs auth set — paste when prompted, stored in the OS
            keychain
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={secret.acked}
              onChange={(event) =>
                setSecret({
                  ...secret,
                  acked: event.target.checked,
                  closeWarned: false,
                })
              }
            />
            I&apos;ve stored this key — it won&apos;t be shown again.
          </label>
          {secret.closeWarned && !secret.acked ? (
            <p className="field-error" role="alert">
              You haven&apos;t confirmed you stored this key. Tick the box and
              press Done, or press Esc again to discard it permanently.
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={!secret.acked}
              onClick={() => setSecret(null)}
            >
              Done
            </button>
          </div>
        </Dialog>
      ) : null}

      {revokeTarget ? (
        <Dialog
          title={`Revoke ${revokeTarget.name}?`}
          tone="danger"
          busy={revoking}
          onClose={() => setRevokeTarget(null)}
        >
          <p>
            CLI calls using this key start failing immediately (exit 3). This
            cannot be undone — create a new key to restore access.
          </p>
          <p className="muted cell-mono">
            {maskKey(revokeTarget.prefix, revokeTarget.last_four)}
            {isAdmin && revokeTarget.ownerName
              ? ` · owner ${revokeTarget.ownerName}`
              : ""}{" "}
            · last used {formatDateTime(revokeTarget.last_used_at)}
          </p>
          {revokeError ? (
            <p className="field-error" role="alert">
              {revokeError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              disabled={revoking}
              onClick={() => setRevokeTarget(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={revoking}
              onClick={() => void confirmRevoke()}
            >
              {revoking ? "Revoking…" : "Revoke key"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
