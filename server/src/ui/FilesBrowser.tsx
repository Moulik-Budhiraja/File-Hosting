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
import { formatDateTime, formatSize } from "@/lib/format";
import type { FileMetadata, PublicUser, Visibility } from "@/lib/types";
import { Dialog } from "./Dialog";
import { VisibilitySelector } from "./VisibilitySelector";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; status: number }
  | { kind: "ready"; items: FileMetadata[]; nextCursor: string | null };

type VisibilityFilter = "all" | Visibility;

const PAGE_LIMIT = 50;

export function FilesBrowser() {
  const { user, isAdmin } = useAuth();
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState<VisibilityFilter>("all");
  const [scope, setScope] = useState<"everyone" | "mine">("everyone");
  const [cursor, setCursor] = useState<string | null>(null);
  const [prevCursors, setPrevCursors] = useState<Array<string | null>>([]);
  const [owners, setOwners] = useState<Map<string, string> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (visibility !== "all") params.set("visibility", visibility);
    params.set("limit", String(PAGE_LIMIT));
    if (cursor) params.set("cursor", cursor);
    try {
      const result = await apiFetch<{
        items: FileMetadata[];
        next_cursor: string | null;
      }>(`/api/files?${params.toString()}`);
      setState({
        kind: "ready",
        items: result.items,
        nextCursor: result.next_cursor,
      });
    } catch (error) {
      setState({ kind: "error", status: isApiError(error) ? error.status : 0 });
    }
  }, [query, visibility, cursor]);

  useEffect(() => {
    void load();
  }, [load]);

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
    return owners?.get(file.owner_id) ?? `${file.owner_id.slice(0, 8)}…`;
  }

  const items = useMemo(
    () => (state.kind === "ready" ? state.items : []),
    [state],
  );
  const visibleItems = useMemo(
    () =>
      scope === "mine"
        ? items.filter((file) => file.owner_id === user.id)
        : items,
    [items, scope, user.id],
  );
  const selected = items.find((file) => file.id === selectedId) ?? null;
  const canManageSelected =
    selected !== null &&
    (isAdmin || (selected.owner_id !== null && selected.owner_id === user.id));

  function resetPaging() {
    setCursor(null);
    setPrevCursors([]);
  }

  function whoSeesIt(file: FileMetadata): string {
    if (file.visibility === "public") return "anyone with the link";
    if (file.visibility === "protected") {
      return "every signed-in member and admin";
    }
    return `${ownerLabel(file)} + admins · others: 404`;
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
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setUploadError(
          payload?.error?.message
            ? `${payload.error.message}.`
            : `Upload failed (${response.status}). Nothing was stored.`,
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
      setUploadError("Upload failed — network error. Nothing was stored.");
    } finally {
      setBusy(false);
    }
  }

  async function saveVisibility() {
    if (!selected || busy) return;
    setBusy(true);
    setEditorError(null);
    try {
      const updated = await apiFetch<FileMetadata>(
        `/api/files/${encodeURIComponent(selected.id)}`,
        { method: "PATCH", body: { visibility: editorValue } },
      );
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
    } catch (error) {
      setEditorError(
        isApiError(error) && error.status === 404
          ? "This file no longer exists or you don't have access. Nothing was changed."
          : "The server couldn't save the change. Nothing was changed.",
      );
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
      setDeleteError(
        isApiError(error) && error.status === 404
          ? "This file no longer exists or you don't have access."
          : "The server couldn't delete the file. It is still stored.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Files">
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
              onClick={() => setScope(value)}
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
          <p className="error-title">Couldn&apos;t load files</p>
          <p className="muted">
            GET /api/files → {state.status || "network"} · nothing was changed
          </p>
          <button type="button" className="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === "ready" && items.length === 0 ? (
        <div className="table-fallback">
          <p className="empty-title">No files here yet</p>
          <p className="muted">
            Upload from this page or with the fs CLI (fs up). Filters may also
            be hiding everything.
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
            <span>
              {visibleItems.length} of {items.length} loaded rows shown
              {scope === "mine" ? " · owner filter applies to loaded rows" : ""}
            </span>
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
          </div>
        </>
      ) : null}

      {selected ? (
        <section
          className="detail-split inspector"
          aria-label="Object record · access"
        >
          <div className="detail-facts">
            <h2 className="detail-title">
              {selected.name}{" "}
              <span className="muted cell-mono">GET /{selected.id}</span>
            </h2>
            <dl className="fact-list">
              <div className="fact-row">
                <dt>owner</dt>
                <dd>{ownerLabel(selected)}</dd>
              </div>
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
                <dt>who sees it</dt>
                <dd>{whoSeesIt(selected)}</dd>
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
            {!canManageSelected ? (
              <p className="muted">
                This file is managed by its owner and admins.
              </p>
            ) : null}
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
        <Dialog title="Upload file" onClose={() => setUploadOpen(false)}>
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
              <p className="field-hint">defaults to the chosen file name</p>
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
          onClose={() => setDeleteOpen(false)}
        >
          <p>
            The file and its stored bytes are removed immediately. Existing
            links stop working. This cannot be undone.
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
