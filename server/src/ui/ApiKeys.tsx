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
import {
  boundPrevCursors,
  decodePrevCursors,
  encodePrevCursors,
  readTaskParam,
} from "@/lib/task-url";
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
  keyId: string;
  name: string;
  secret: string;
  acked: boolean;
  copied: boolean;
  copyFailed: boolean;
  closeWarned: boolean;
  /** Phase-2 progress: the key is only a live credential once "active". */
  activation: "activating" | "active" | "failed";
}

interface CreatedKeyResponse {
  api_key: {
    id: string;
    name?: string;
    secret: string | null;
    status?: "pending" | "active";
    pending_expires_at?: string | null;
    created?: boolean;
  };
}

export function maskKey(prefix: string, lastFour: string): string {
  return `${prefix.slice(0, 8)} ···· ${lastFour}`;
}

export function ApiKeysView() {
  const { user, isAdmin } = useAuth();
  const [state, setState] = useState<ListState>({ kind: "loading" });
  // Search/cursor task state lives in the URL (never secrets) so session
  // expiry + reauth restores the exact page and query.
  const [search, setSearch] = useState(() => readTaskParam("q") ?? "");
  // Debounced server query for the aggregate view. The member/mine list
  // is unpaginated, so its client-side filter is complete; the aggregate
  // is paginated, so search must happen in SQL before pagination.
  const [query, setQuery] = useState(() => readTaskParam("q")?.trim() ?? "");
  // Sanitized: only the two known values, and only for admins (members
  // are always scoped to their own keys).
  const [scope, setScope] = useState<"all" | "mine">(() => {
    const fromUrl = readTaskParam("scope");
    if (isAdmin && (fromUrl === "all" || fromUrl === "mine")) return fromUrl;
    return isAdmin ? "all" : "mine";
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<SecretState | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<KeyRow | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  // Reauth reconcile for a pending key whose show-once dialog was
  // interrupted: only safe metadata survives — never the secret.
  const [reconcileTarget, setReconcileTarget] = useState<KeyRow | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  // Selection/pending ids restored from the URL exactly once, after the
  // first list load (stale ids simply find no row and degrade).
  const restoreSelRef = useRef(readTaskParam("sel"));
  const restorePendRef = useRef(readTaskParam("pend"));
  // Flipped once restoration has been attempted so the URL reflect effect
  // re-runs and drops stale ids that matched no row.
  const [, setRestoreDone] = useState(false);
  const [cursor, setCursor] = useState<string | null>(() =>
    readTaskParam("cursor"),
  );
  const [prevCursors, setPrevCursors] = useState<Array<string | null>>(() =>
    decodePrevCursors(readTaskParam("prev")),
  );
  const nameId = useId();
  const nameErrorId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  // Validation/server errors belong to the name field: announce them,
  // expose the relationship on the input, and return focus there.
  function failCreate(message: string) {
    setCreateError(message);
    nameRef.current?.focus();
  }

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
        if (query) params.set("q", query);
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
      if (isApiError(error) && error.code === "invalid_cursor" && cursor) {
        // A restored cursor can be stale or foreign. Degrade to the first
        // page of the same task instead of an error screen or a loop.
        setCursor(null);
        setPrevCursors([]);
        return;
      }
      setState({
        kind: "error",
        status: isApiError(error) ? error.status : 0,
      });
    }
  }, [begin, isAdmin, scope, cursor, query, user.username]);

  useEffect(() => {
    void load();
  }, [load]);

  // Restore selection / pending-reconcile state once the list is loaded.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const pendId = restorePendRef.current;
    const selId = restoreSelRef.current;
    if (!pendId && !selId) return;
    restorePendRef.current = null;
    restoreSelRef.current = null;
    setRestoreDone(true);
    if (pendId) {
      const key = state.keys.find(
        (row) =>
          row.id === pendId && row.status === "pending" && !row.revoked_at,
      );
      if (key) {
        setReconcileTarget(key);
        return;
      }
    }
    if (selId) {
      const key = state.keys.find((row) => row.id === selId && !row.revoked_at);
      if (key) setRevokeTarget(key);
    }
  }, [state]);

  // Reflect restorable task state into the URL (replace, not push).
  // Only opaque non-secret values: query text, cursors, scope, key ids.
  const pendId =
    (secret && secret.activation !== "active" ? secret.keyId : null) ??
    reconcileTarget?.id ??
    restorePendRef.current;
  const selId = revokeTarget?.id ?? restoreSelRef.current;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const setOrDelete = (name: string, value: string | null) => {
      if (value) params.set(name, value);
      else params.delete(name);
    };
    setOrDelete("q", query || null);
    setOrDelete("cursor", cursor);
    setOrDelete("prev", encodePrevCursors(prevCursors));
    setOrDelete("scope", isAdmin && scope === "mine" ? "mine" : null);
    setOrDelete("sel", selId);
    setOrDelete("pend", pendId);
    const encoded = params.toString();
    const target = `${window.location.pathname}${encoded ? `?${encoded}` : ""}`;
    if (target !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", target);
    }
  }, [query, cursor, prevCursors, isAdmin, scope, selId, pendId]);

  // Debounce typed search into the server query and restart pagination
  // from the first page of the new result set.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = search.trim();
      setQuery((current) => {
        if (current === next) return current;
        setCursor(null);
        setPrevCursors([]);
        return next;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const aggregate = isAdmin && scope === "all";
  const visible = useMemo(() => {
    if (state.kind !== "ready") return [];
    // Aggregate rows are already searched server-side; filtering them
    // again per page would reintroduce false empties.
    if (aggregate) return state.keys;
    const needle = search.trim().toLocaleLowerCase("en-US");
    return state.keys.filter(
      (key) => !needle || key.name.toLocaleLowerCase("en-US").includes(needle),
    );
  }, [state, search, aggregate]);

  const activeCount =
    state.kind === "ready"
      ? state.keys.filter((key) => !key.revoked_at && key.status !== "pending")
          .length
      : 0;
  const pendingCount =
    state.kind === "ready"
      ? state.keys.filter((key) => !key.revoked_at && key.status === "pending")
          .length
      : 0;

  // Phase 2: activate only after this client has the secret in hand.
  // Idempotent server-side, so a lost activation response is retried
  // safely from the dialog.
  async function activateKey(keyId: string) {
    const mark = (activation: SecretState["activation"]) => {
      setSecret((current) =>
        current?.keyId === keyId ? { ...current, activation } : current,
      );
    };
    mark("activating");
    try {
      await apiFetch(`/api/api-keys/${encodeURIComponent(keyId)}/activate`, {
        method: "POST",
      });
      mark("active");
      void load();
    } catch {
      mark("failed");
    }
  }

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    if (creating) return;
    const name = createName.trim();
    if (!name) {
      failCreate("Name the machine or job this key is for.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    // Idempotency id: a lost response can be reconciled without ever
    // re-exposing the plaintext secret.
    const requestId = crypto.randomUUID();
    const create = () =>
      apiFetch<CreatedKeyResponse>("/api/api-keys", {
        method: "POST",
        body: { name, request_id: requestId },
      });
    try {
      let created: CreatedKeyResponse;
      try {
        created = await create();
      } catch (error) {
        if (isApiError(error)) {
          failCreate(`${error.message}.`);
          return;
        }
        // The response was lost — the server may or may not have
        // committed. Probe with the SAME request id for a truthful answer.
        try {
          created = await create();
        } catch {
          failCreate(
            "The request may not have reached the server. Reload to check — a half-created key appears in the list as pending, is never usable for authentication, and expires automatically.",
          );
          return;
        }
      }
      if (!created.api_key.secret) {
        // The server committed on the lost first attempt; the secret is
        // gone in transit but the key was NEVER activated.
        failCreate(
          "The key was created but its secret was lost in transit. It stays pending — never usable for authentication — and expires automatically. Cancel it in the list and create a new key.",
        );
        void load();
        return;
      }
      setCreateOpen(false);
      setCreateName("");
      const keyId = created.api_key.id;
      const pending = created.api_key.status === "pending";
      setSecret({
        keyId,
        name,
        secret: created.api_key.secret,
        acked: false,
        copied: false,
        copyFailed: false,
        closeWarned: false,
        activation: pending ? "activating" : "active",
      });
      void load();
      if (pending) void activateKey(keyId);
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
      if (isApiError(error) && error.status === 404) {
        setRevokeError("API key not found — it may already be revoked.");
      } else if (isApiError(error) && error.status < 500) {
        setRevokeError(`${error.message}.`);
      } else {
        // Ambiguous transport/5xx failure: the revoke may have committed.
        setRevokeError(
          revokeTarget.status === "pending"
            ? "The server didn't confirm — the pending key may or may not have been cancelled. Retry; a pending key never authenticates either way."
            : "The server didn't confirm — the key may or may not have been revoked. Retry (revoking again is safe) or reload the list.",
        );
      }
    } finally {
      setRevoking(false);
    }
  }

  // Reconcile an interrupted pending key after reauth. The secret is not
  // recoverable; the user either confirms they stored it (activate) or
  // cancels the never-active row.
  async function reconcileActivate() {
    if (!reconcileTarget || reconciling) return;
    setReconciling(true);
    setReconcileError(null);
    try {
      await apiFetch(
        `/api/api-keys/${encodeURIComponent(reconcileTarget.id)}/activate`,
        { method: "POST" },
      );
      setReconcileTarget(null);
      void load();
    } catch (error) {
      setReconcileError(
        isApiError(error) && error.code === "pending_expired"
          ? "This pending key has expired — cancel it and create a new one."
          : "Activation wasn't confirmed — it may or may not have completed. Retry is safe (activation is idempotent), or cancel the key.",
      );
    } finally {
      setReconciling(false);
    }
  }

  async function reconcileCancel() {
    if (!reconcileTarget || reconciling) return;
    setReconciling(true);
    setReconcileError(null);
    try {
      await apiFetch(
        `/api/api-keys/${encodeURIComponent(reconcileTarget.id)}`,
        {
          method: "DELETE",
        },
      );
      setReconcileTarget(null);
      void load();
    } catch (error) {
      if (isApiError(error) && error.status === 404) {
        // Already gone (expired and pruned) — that is the desired end state.
        setReconcileTarget(null);
        void load();
        return;
      }
      setReconcileError(
        "The cancellation wasn't confirmed — the key may or may not remain listed. Either way a pending key never authenticates; try again.",
      );
    } finally {
      setReconciling(false);
    }
  }

  return (
    <section aria-label="API keys">
      <div className="toolbar">
        <input
          type="search"
          className="toolbar-search"
          placeholder="search keys"
          aria-label={
            aggregate ? "Search key name or owner" : "Search key name"
          }
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
        {state.kind === "ready" &&
        state.keys.length === 0 &&
        !(aggregate ? query : search.trim()) ? null : (
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
        )}
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
          <p className="error-title">
            Couldn&apos;t load keys ({state.status || "network"})
          </p>
          <button type="button" className="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === "ready" &&
      state.keys.length === 0 &&
      (aggregate ? query : search.trim()) ? (
        <div className="table-fallback">
          <p className="muted">no keys match the current filters</p>
        </div>
      ) : null}

      {state.kind === "ready" &&
      state.keys.length === 0 &&
      !(aggregate ? query : search.trim()) ? (
        <div className="table-fallback">
          <p className="empty-title">No API keys</p>
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
                      {key.revoked_at
                        ? "revoked"
                        : key.status === "pending"
                          ? "pending"
                          : "active"}
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
                      : key.status === "pending"
                        ? `pending · never authenticates · expires ${formatDateTime(
                            key.pending_expires_at ?? null,
                          )}`
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
                        {key.status === "pending" ? "Cancel" : "Revoke"}
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
              {activeCount} active
              {pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
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
                    setPrevCursors(boundPrevCursors([...prevCursors, cursor]));
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

      {createOpen ? (
        <Dialog
          title="New API key"
          busy={creating}
          onClose={() => setCreateOpen(false)}
        >
          <form onSubmit={submitCreate} noValidate>
            <div className="field">
              <label htmlFor={nameId}>Name</label>
              <input
                ref={nameRef}
                id={nameId}
                type="text"
                value={createName}
                aria-invalid={createError ? true : undefined}
                aria-describedby={createError ? nameErrorId : undefined}
                onChange={(event) => {
                  setCreateName(event.target.value);
                  setCreateError(null);
                }}
              />
              <p className="field-hint">e.g. laptop-mbp · ci-runner</p>
              {createError ? (
                <p id={nameErrorId} className="field-error" role="alert">
                  {createError}
                </p>
              ) : null}
            </div>
            <p className="muted">
              Uses your current account permissions until revoked.
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
        <Dialog title={`Key created — ${secret.name}`} onClose={closeSecret}>
          <p>Copy this key now. It won&apos;t be shown again.</p>
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
          {secret.activation === "activating" ? (
            <p className="muted" role="status">
              activating key…
            </p>
          ) : secret.activation === "active" ? (
            <p className="muted" role="status">
              key active — ready to use
            </p>
          ) : (
            <p className="field-error" role="alert">
              This key may not be active — the activation wasn&apos;t confirmed.
              It cannot authenticate until activated.{" "}
              <button
                type="button"
                className="link-button"
                onClick={() => void activateKey(secret.keyId)}
              >
                Retry activation
              </button>
            </p>
          )}
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
            I&apos;ve stored this key
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

      {reconcileTarget ? (
        <Dialog
          title={`Pending key ${reconcileTarget.name}`}
          busy={reconciling}
          onClose={() => setReconcileTarget(null)}
        >
          <p>
            This key was created but never activated. Its secret was shown only
            once and cannot be shown again.
          </p>
          <p className="muted">
            If you stored the secret, activate the key now. If not, cancel it
            and create a new one — a pending key never authenticates and expires{" "}
            {formatDateTime(reconcileTarget.pending_expires_at ?? null)}.
          </p>
          {reconcileError ? (
            <p className="field-error" role="alert">
              {reconcileError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              disabled={reconciling}
              onClick={() => setReconcileTarget(null)}
            >
              Close
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={reconciling}
              onClick={() => void reconcileCancel()}
            >
              {reconciling ? "Working…" : "Cancel key"}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={reconciling}
              onClick={() => void reconcileActivate()}
            >
              Activate — I stored it
            </button>
          </div>
        </Dialog>
      ) : null}

      {revokeTarget ? (
        <Dialog
          title={
            revokeTarget.status === "pending"
              ? `Cancel pending key ${revokeTarget.name}?`
              : `Revoke ${revokeTarget.name}?`
          }
          tone="danger"
          busy={revoking}
          onClose={() => setRevokeTarget(null)}
        >
          {revokeTarget.status === "pending" ? (
            <p>This key is inactive. Cancelling removes it.</p>
          ) : (
            <p>This key stops working immediately. This cannot be undone.</p>
          )}
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
              {revokeTarget.status === "pending"
                ? revoking
                  ? "Cancelling…"
                  : "Cancel key"
                : revoking
                  ? "Revoking…"
                  : "Revoke key"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
