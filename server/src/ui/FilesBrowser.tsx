"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { apiFetch, isApiError, notifyUnauthorized } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateTime, formatSize } from "@/lib/format";
import {
  boundPrevCursors,
  decodePrevCursors,
  encodePrevCursors,
  readTaskParam,
} from "@/lib/task-url";
import { useLatest } from "@/lib/use-latest";
import type { FileMetadata, PublicUser, Visibility } from "@/lib/types";
import { Dialog } from "./Dialog";
import { VisibilitySelector } from "./VisibilitySelector";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; status: number }
  | { kind: "ready"; items: FileMetadata[]; nextCursor: string | null };

type VisibilityFilter = "all" | Visibility;

const PAGE_LIMIT = 50;

// Task state lives in the URL so session expiry + reauth can return to
// the exact filter/search/page/selection the user was on.
function initialVisibility(): VisibilityFilter {
  const value = readTaskParam("visibility");
  return value === "public" || value === "protected" || value === "private"
    ? value
    : "all";
}

export function FilesBrowser() {
  const { user, isAdmin } = useAuth();
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [search, setSearch] = useState(() => readTaskParam("q") ?? "");
  const [query, setQuery] = useState(() => readTaskParam("q") ?? "");
  const [visibility, setVisibility] =
    useState<VisibilityFilter>(initialVisibility);
  // Paper board IA-07: members default to Mine; admins default to
  // Everyone. An explicit URL value wins either way.
  const [scope, setScope] = useState<"everyone" | "mine">(() => {
    const fromUrl = readTaskParam("scope");
    if (fromUrl === "mine" || fromUrl === "everyone") return fromUrl;
    return isAdmin ? "everyone" : "mine";
  });
  const [cursor, setCursor] = useState<string | null>(() =>
    readTaskParam("cursor"),
  );
  const [prevCursors, setPrevCursors] = useState<Array<string | null>>(() =>
    decodePrevCursors(readTaskParam("prev")),
  );
  const [owners, setOwners] = useState<Map<string, string> | null>(null);
  const [reconcileNotice, setReconcileNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    readTaskParam("sel"),
  );
  // A selection restored from the URL is validated once against the first
  // completed load; a stale id is dropped (like Keys) instead of lingering
  // in the query. Later pagination keeps in-session selections intact.
  const restoreSelRef = useRef(readTaskParam("sel"));
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [uploadVisibility, setUploadVisibility] =
    useState<Visibility>("public");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorValue, setEditorValue] = useState<Visibility>("public");
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileId = useId();
  const nameId = useId();
  const searchRef = useRef<HTMLInputElement>(null);

  const { begin } = useLatest();

  const load = useCallback(async () => {
    const ticket = begin();
    setState({ kind: "loading" });
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (visibility !== "all") params.set("visibility", visibility);
    // Owner scoping happens in SQL before pagination — "Mine" is truthful
    // across every page, not a per-page client filter.
    if (scope === "mine") params.set("owner", "me");
    params.set("limit", String(PAGE_LIMIT));
    if (cursor) params.set("cursor", cursor);
    try {
      const result = await apiFetch<{
        items: FileMetadata[];
        next_cursor: string | null;
      }>(`/api/files?${params.toString()}`, { signal: ticket.signal });
      if (!ticket.current()) return;
      setState({
        kind: "ready",
        items: result.items,
        nextCursor: result.next_cursor,
      });
    } catch (error) {
      if (!ticket.current()) return;
      if (isApiError(error) && error.code === "invalid_cursor" && cursor) {
        // A restored cursor can be stale or foreign. Degrade to the first
        // page of the same task instead of an error screen or a loop.
        setCursor(null);
        setPrevCursors([]);
        return;
      }
      setState({ kind: "error", status: isApiError(error) ? error.status : 0 });
    }
  }, [begin, query, visibility, scope, cursor]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const restored = restoreSelRef.current;
    if (!restored) return;
    restoreSelRef.current = null;
    if (!state.items.some((item) => item.id === restored)) {
      setSelectedId((current) => (current === restored ? null : current));
    }
  }, [state]);

  // Reflect the task state into the URL (replace, not push — filters are
  // one task, not a history trail).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const setOrDelete = (name: string, value: string | null) => {
      if (value) params.set(name, value);
      else params.delete(name);
    };
    setOrDelete("q", query || null);
    setOrDelete("visibility", visibility === "all" ? null : visibility);
    // Only persist the role-relative non-default scope (admin Mine, member
    // Everyone). The default is omitted so a fresh post-scrub mount never
    // recreates a scrubbed old-account parameter with a default write.
    setOrDelete(
      "scope",
      scope === (isAdmin ? "everyone" : "mine") ? null : scope,
    );
    setOrDelete("cursor", cursor);
    setOrDelete("prev", encodePrevCursors(prevCursors));
    setOrDelete("sel", selectedId);
    const search = params.toString();
    const target = `${window.location.pathname}${search ? `?${search}` : ""}`;
    if (target !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", target);
    }
  }, [query, visibility, isAdmin, scope, cursor, prevCursors, selectedId]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    void apiFetch<{ users: PublicUser[] }>("/api/users")
      .then(({ users }) => {
        if (cancelled) return;
        setOwners(new Map(users.map((entry) => [entry.id, entry.username])));
      })
      .catch(() => {
        // Owner names stay unresolved; ids are shown instead.
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  function ownerLabel(file: FileMetadata): string {
    if (!file.owner_id) return "—";
    if (file.owner_id === user.id) return "you";
    const resolved = owners?.get(file.owner_id);
    if (resolved) return resolved;
    // Members cannot resolve other users' names (the directory is
    // admin-only); a neutral truthful label beats a UUID stub.
    return isAdmin ? `${file.owner_id.slice(0, 8)}…` : "another user";
  }

  const items = useMemo(
    () => (state.kind === "ready" ? state.items : []),
    [state],
  );
  // The server already applied the owner scope; every loaded row is
  // visible.
  const visibleItems = items;
  const selected = items.find((file) => file.id === selectedId) ?? null;
  const canManageSelected =
    selected !== null &&
    (isAdmin || (selected.owner_id !== null && selected.owner_id === user.id));

  function resetPaging() {
    setCursor(null);
    setPrevCursors([]);
  }

  async function submitUpload(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!uploadFile) {
      setUploadError("Choose a file to upload.");
      return;
    }
    setBusy(true);
    setUploadError(null);
    const params = new URLSearchParams();
    params.set("name", uploadName.trim() || uploadFile.name);
    params.set("visibility", uploadVisibility);
    try {
      const response = await fetch(`/api/files?${params.toString()}`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": uploadFile.type || "application/octet-stream",
        },
        body: uploadFile,
      });
      if (response.status === 401) {
        // The session died mid-upload. Route through the shared reauth
        // flow with browser-session wording — never the backend's
        // bearer-token phrasing.
        setUploadError(
          "Your session expired during the upload — sign in again to continue.",
        );
        notifyUnauthorized();
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setUploadError(
          payload?.error?.message
            ? `${payload.error.message}.`
            : response.status < 500
              ? `Upload failed (${response.status}). Nothing was stored.`
              : `Upload failed (${response.status}). Reload the list to check whether it was stored.`,
        );
        return;
      }
      setUploadOpen(false);
      setUploadFile(null);
      setUploadName("");
      setUploadVisibility("public");
      resetPaging();
      void load();
    } catch {
      setUploadError(
        "Upload failed — network error. The file may or may not have been stored; reload the list to check.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveVisibility() {
    if (!selected || busy) return;
    setBusy(true);
    setEditorError(null);
    setReconcileNotice(null);
    const applyUpdated = (updated: FileMetadata) => {
      setEditorOpen(false);
      setState((current) =>
        current.kind === "ready"
          ? {
              ...current,
              items: current.items.map((file) =>
                file.id === updated.id ? updated : file,
              ),
            }
          : current,
      );
    };
    try {
      const updated = await apiFetch<FileMetadata>(
        `/api/files/${encodeURIComponent(selected.id)}`,
        { method: "PATCH", body: { visibility: editorValue } },
      );
      applyUpdated(updated);
    } catch (error) {
      if (isApiError(error) && error.status === 404) {
        setEditorError(
          "This file no longer exists or you don't have access. Nothing was changed.",
        );
      } else if (isApiError(error) && error.status < 500) {
        setEditorError(`${error.message}.`);
      } else {
        // Transport failure after the change may have committed: the
        // authoritative record decides — reconciled success if the
        // desired visibility is present, an explicit unknown otherwise.
        try {
          const current = await apiFetch<FileMetadata>(
            `/api/files/${encodeURIComponent(selected.id)}`,
          );
          if (current.visibility === editorValue) {
            applyUpdated(current);
            setReconcileNotice("Visibility confirmed after reconnect.");
            return;
          }
        } catch {
          // Verification also failed; the outcome stays unknown.
        }
        setEditorError(
          "The server didn't confirm — the change may or may not have been saved. Retry (saving the same choice again is safe) or reload to check.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!selected || busy) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await apiFetch(`/api/files/${encodeURIComponent(selected.id)}`, {
        method: "DELETE",
      });
      setDeleteOpen(false);
      setSelectedId(null);
      void load();
    } catch (error) {
      if (isApiError(error) && error.status === 404) {
        setDeleteError("This file no longer exists or you don't have access.");
      } else if (isApiError(error) && error.status < 500) {
        setDeleteError(`${error.message}.`);
      } else {
        // Ambiguous transport/5xx failure: the delete may have committed.
        // The authoritative record decides.
        try {
          await apiFetch(`/api/files/${encodeURIComponent(selected.id)}`);
          setDeleteError(
            "The delete didn't complete — the file is still there. Try again.",
          );
        } catch (probeError) {
          if (isApiError(probeError) && probeError.status === 404) {
            // The record is gone: the delete committed — reconciled.
            setDeleteOpen(false);
            setSelectedId(null);
            void load();
          } else {
            setDeleteError(
              "The server didn't confirm — the file may or may not have been deleted. Reload the list to check.",
            );
          }
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Files">
      {reconcileNotice ? (
        <p className="notice notice-success" role="status">
          {reconcileNotice}
        </p>
      ) : null}
      <div className="toolbar">
        <form
          className="toolbar-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            resetPaging();
            setQuery(search.trim());
          }}
        >
          <input
            ref={searchRef}
            type="search"
            className="toolbar-search"
            placeholder="search name or tag"
            aria-label="Search name or tag"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </form>
        <div className="segment" role="group" aria-label="Visibility filter">
          {(["all", "public", "protected", "private"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`segment-item${visibility === value ? " segment-item-active" : ""}`}
              aria-pressed={visibility === value}
              onClick={() => {
                resetPaging();
                setVisibility(value);
              }}
            >
              {value === "all"
                ? "All"
                : value.charAt(0).toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        <div className="segment" role="group" aria-label="Owner filter">
          {(["everyone", "mine"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`segment-item${scope === value ? " segment-item-active" : ""}`}
              aria-pressed={scope === value}
              onClick={() => {
                resetPaging();
                setScope(value);
              }}
            >
              {value === "everyone" ? "Everyone" : "Mine"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            setUploadError(null);
            setUploadOpen(true);
          }}
        >
          Upload
        </button>
      </div>

      {state.kind === "loading" ? (
        <div className="table-fallback">
          <div className="skeleton-row" aria-hidden="true" />
          <div className="skeleton-row" aria-hidden="true" />
          <p className="muted" role="status">
            loading files…
          </p>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="table-fallback" role="alert">
          <p className="error-title">
            Couldn&apos;t load files ({state.status || "network"})
          </p>
          <button type="button" className="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === "ready" && items.length === 0 ? (
        <div className="table-fallback">
          <p className="empty-title">
            {query ||
            visibility !== "all" ||
            scope !== (isAdmin ? "everyone" : "mine")
              ? "No files match the current filters"
              : "No files"}
          </p>
        </div>
      ) : null}

      {state.kind === "ready" && items.length > 0 ? (
        <>
          <table className="data-table data-table-selectable">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="cell-num col-desktop">
                  Size
                </th>
                <th scope="col" className="col-desktop">
                  Mime
                </th>
                <th scope="col" className="col-desktop">
                  Owner
                </th>
                <th scope="col" className="col-desktop">
                  Visibility
                </th>
                <th scope="col" className="col-desktop">
                  Uploaded
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((file) => (
                <tr
                  key={file.id}
                  className={
                    file.id === selectedId ? "row-selected" : undefined
                  }
                >
                  <td className="cell-strong">
                    <button
                      type="button"
                      className="row-open"
                      onClick={() =>
                        setSelectedId(selectedId === file.id ? null : file.id)
                      }
                    >
                      {file.name}
                      <span className="row-sub" aria-hidden="true">
                        {formatSize(file.size)} · {file.visibility} ·{" "}
                        {ownerLabel(file)}
                      </span>
                    </button>
                  </td>
                  <td className="cell-mono cell-num col-desktop">
                    {formatSize(file.size)}
                  </td>
                  <td className="cell-mono cell-muted col-desktop">
                    {file.mime_type}
                  </td>
                  <td className="cell-mono col-desktop">{ownerLabel(file)}</td>
                  <td className="cell-mono col-desktop">{file.visibility}</td>
                  <td className="cell-mono cell-num col-desktop">
                    {formatDateTime(file.created_at)}
                  </td>
                </tr>
              ))}
              {visibleItems.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    no files match the current filters
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div className="table-footline table-footline-split">
            <span>{items.length} rows</span>
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
          </div>
        </>
      ) : null}

      {selected ? (
        <section
          className="detail-split inspector"
          aria-label="Object record · access"
        >
          <div className="detail-facts">
            <h2 className="detail-title">{selected.name}</h2>
            <dl className="fact-list">
              {selected.owner_id ? (
                <div className="fact-row">
                  <dt>owner</dt>
                  <dd>{ownerLabel(selected)}</dd>
                </div>
              ) : null}
              <div className="fact-row">
                <dt>visibility</dt>
                <dd>
                  {selected.visibility}
                  {canManageSelected ? (
                    <button
                      type="button"
                      className="button button-small fact-action"
                      onClick={() => {
                        setEditorError(null);
                        setEditorValue(selected.visibility);
                        setEditorOpen(true);
                      }}
                    >
                      Change…
                    </button>
                  ) : null}
                </dd>
              </div>
              <div className="fact-row">
                <dt>size · type</dt>
                <dd>
                  {formatSize(selected.size)} · {selected.mime_type}
                </dd>
              </div>
              {selected.tags.length > 0 ? (
                <div className="fact-row">
                  <dt>tags</dt>
                  <dd>{selected.tags.join(" · ")}</dd>
                </div>
              ) : null}
              <div className="fact-row">
                <dt>links</dt>
                <dd>
                  <a href={selected.preview_url}>preview</a> ·{" "}
                  <a href={selected.raw_url}>raw</a>
                </dd>
              </div>
              <div className="fact-row">
                <dt>uploaded</dt>
                <dd>{formatDateTime(selected.created_at)}</dd>
              </div>
            </dl>
          </div>
          {canManageSelected ? (
            <div className="detail-actions">
              <h2 className="section-label">Actions</h2>
              <button
                type="button"
                className="button button-block"
                onClick={() => {
                  setEditorError(null);
                  setEditorValue(selected.visibility);
                  setEditorOpen(true);
                }}
              >
                Change visibility…
              </button>
              <button
                type="button"
                className="button button-block button-danger-outline"
                onClick={() => {
                  setDeleteError(null);
                  setDeleteOpen(true);
                }}
              >
                Delete…
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {uploadOpen ? (
        <Dialog
          title="Upload file"
          busy={busy}
          onClose={() => setUploadOpen(false)}
        >
          <form onSubmit={submitUpload} noValidate>
            <div className="field">
              <label htmlFor={fileId}>File</label>
              <input
                id={fileId}
                type="file"
                onChange={(event) => {
                  const chosen = event.target.files?.[0] ?? null;
                  setUploadFile(chosen);
                  if (chosen && !uploadName) setUploadName(chosen.name);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={nameId}>Name</label>
              <input
                id={nameId}
                type="text"
                value={uploadName}
                onChange={(event) => setUploadName(event.target.value)}
              />
            </div>
            <VisibilitySelector
              value={uploadVisibility}
              onChange={setUploadVisibility}
            />
            {uploadError ? (
              <p className="field-error" role="alert">
                {uploadError}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setUploadOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button button-primary"
                disabled={busy}
              >
                {busy ? "Uploading…" : "Upload file"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {editorOpen && selected ? (
        <Dialog
          title="Who can open this file?"
          busy={busy}
          onClose={() => setEditorOpen(false)}
        >
          <p className="muted cell-mono">{selected.name}</p>
          <VisibilitySelector
            value={editorValue}
            onChange={setEditorValue}
            ownerPhrase={selected.owner_id === user.id ? "you" : "the owner"}
          />
          {editorError ? (
            <p className="field-error" role="alert">
              {editorError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setEditorOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => void saveVisibility()}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </Dialog>
      ) : null}

      {deleteOpen && selected ? (
        <Dialog
          title={`Delete ${selected.name}?`}
          tone="danger"
          busy={busy}
          onClose={() => setDeleteOpen(false)}
        >
          <p>
            The file is removed immediately. Existing links stop working. This
            cannot be undone.
          </p>
          {deleteError ? (
            <p className="field-error" role="alert">
              {deleteError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setDeleteOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              {busy ? "Deleting…" : "Delete file"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
