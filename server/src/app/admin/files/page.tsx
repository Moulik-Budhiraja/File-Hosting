"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { adminApi, useAdminData } from "@/admin/client";
import { LoadFallback } from "@/admin/components/LoadFallback";
import { StateBanner } from "@/admin/components/StateBanner";
import {
  formatBytes,
  formatInteger,
  formatListTimestamp,
} from "@/admin/format";
import {
  advancePager,
  initialPager,
  pagerLabel,
  retreatPager,
} from "@/admin/pagination";

const PAGE_SIZE = 16;

type VisibilityFilter = "all" | "public" | "private";

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function UploadDialog({
  open,
  onClose,
  onUploaded,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a file to upload");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminApi.uploadFile(file, {
        name: name.trim() || file.name,
        tags: tags
          .split(/[\s,]+/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        visibility: isPrivate ? "private" : "public",
      });
      onUploaded();
      onClose();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : "Upload failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Upload object"
        className="dialog"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <h2>Upload object</h2>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            File
            <input ref={fileRef} type="file" required />
          </label>
          <label>
            Name (defaults to the file name)
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="report.pdf"
            />
          </label>
          <label>
            Tags (space separated)
            <input
              type="text"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="ingest batch"
            />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(event) => setIsPrivate(event.target.checked)}
            />
            private — requires the bearer token to read
          </label>
          {error ? <p className="text-danger">{error}</p> : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={busy}
            >
              {busy ? "Uploading …" : "Upload"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function FilesPage() {
  const [search, setSearch] = useState("");
  const [glob, setGlob] = useState("");
  const [tag, setTag] = useState("");
  const [visibility, setVisibility] = useState<VisibilityFilter>("all");
  const [pager, setPager] = useState(initialPager);
  const [uploadOpen, setUploadOpen] = useState(false);

  const debouncedSearch = useDebounced(search, 250);
  const debouncedGlob = useDebounced(glob, 250);
  const debouncedTag = useDebounced(tag, 250);

  // Any filter change restarts from the first page.
  useEffect(() => {
    setPager(initialPager());
  }, [debouncedSearch, debouncedGlob, debouncedTag, visibility]);

  const query = useMemo(
    () => ({
      q: debouncedSearch || undefined,
      name: debouncedGlob || undefined,
      tags: debouncedTag ? [debouncedTag] : [],
      visibility: visibility === "all" ? undefined : visibility,
      limit: PAGE_SIZE,
      cursor: pager.cursor,
    }),
    [debouncedSearch, debouncedGlob, debouncedTag, visibility, pager],
  );

  const list = useAdminData(() => adminApi.listFiles(query), [query]);
  const system = useAdminData(() => adminApi.getSystem(), []);

  const items = list.data?.items ?? [];
  const nextCursor = list.data?.next_cursor ?? null;

  return (
    <main className="admin-main">
      <div className="page-header">
        <div>
          <h1 className="page-title">Files</h1>
          <p className="page-subtitle">
            {system.data
              ? `${formatInteger(system.data.storage.object_count)} objects · ${formatBytes(system.data.storage.object_bytes)} stored`
              : "object totals unavailable"}
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => setUploadOpen(true)}
          >
            Upload
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="field field-search">
          <label htmlFor="files-search">search</label>
          <input
            id="files-search"
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="name or tag"
          />
        </div>
        <div className="field field-glob">
          <label htmlFor="files-glob">glob</label>
          <input
            id="files-glob"
            type="text"
            value={glob}
            onChange={(event) => setGlob(event.target.value)}
            placeholder="*.parquet"
          />
        </div>
        <div className="field field-tag">
          <label htmlFor="files-tag">tag</label>
          <input
            id="files-tag"
            type="text"
            value={tag}
            onChange={(event) => setTag(event.target.value)}
            placeholder="ingest"
          />
        </div>
        <div className="segment" role="group" aria-label="Visibility filter">
          {(["all", "public", "private"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={visibility === option}
              onClick={() => setVisibility(option)}
            >
              {option === "all"
                ? "All"
                : option === "public"
                  ? "Public"
                  : "Private"}
            </button>
          ))}
        </div>
        <span className="filter-spacer" />
        <span className="filter-note">newest first · glob is SQLite GLOB</span>
      </div>

      {list.status === "ready" ? (
        items.length === 0 ? (
          <StateBanner state="empty" />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Size
                  </th>
                  <th scope="col" className="cell-optional">
                    MIME
                  </th>
                  <th scope="col" className="cell-optional">
                    Tags
                  </th>
                  <th scope="col">Vis</th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Uploaded
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((file) => (
                  <tr key={file.id}>
                    <td className="cell-name">
                      <Link href={`/admin/files/${file.id}`}>{file.name}</Link>
                    </td>
                    <td className="cell-size">{formatBytes(file.size)}</td>
                    <td className="cell-mime cell-optional">
                      {file.mime_type}
                    </td>
                    <td className="cell-tags cell-optional">
                      {file.tags.join(" ") || "—"}
                    </td>
                    <td className="cell-vis">
                      <span
                        className={`dot ${file.visibility === "public" ? "dot-success" : "dot-muted"}`}
                        aria-hidden
                      />
                      <span className="vis-text">{file.visibility}</span>
                    </td>
                    <td className="cell-time">
                      {formatListTimestamp(file.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <LoadFallback
          status={list.status === "loading" ? "loading" : list.status}
          message={list.message}
          onRetry={list.reload}
        />
      )}

      <div className="pagination-footer">
        <span>
          {list.status === "ready"
            ? `${pagerLabel(pager, PAGE_SIZE, items.length, nextCursor !== null)} · limit ${PAGE_SIZE}`
            : "…"}
        </span>
        <div className="pager-buttons">
          <button
            type="button"
            className="button"
            disabled={pager.page <= 1}
            onClick={() => setPager((current) => retreatPager(current))}
          >
            ← prev
          </button>
          <button
            type="button"
            className="button"
            disabled={nextCursor === null}
            onClick={() =>
              nextCursor
                ? setPager((current) => advancePager(current, nextCursor))
                : undefined
            }
          >
            next →
          </button>
        </div>
      </div>

      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => {
          setPager(initialPager());
          list.reload();
          system.reload();
        }}
      />
    </main>
  );
}
