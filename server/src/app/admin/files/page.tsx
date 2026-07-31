"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { adminApi, useAdminData } from "@/admin/client";
import { LoadFallback } from "@/admin/components/LoadFallback";
import { StaleBanner } from "@/admin/components/StaleBanner";
import { StateBanner } from "@/admin/components/StateBanner";
import { UploadDialog } from "@/admin/components/UploadDialog";
import { VisibilityLabel } from "@/admin/components/VisibilityLabel";
import {
  formatBytes,
  formatInteger,
  formatListTimestamp,
  formatUtcDateTime,
} from "@/admin/format";
import {
  advancePager,
  initialPager,
  pagerLabel,
  retreatPager,
} from "@/admin/pagination";

const PAGE_SIZE = 16;

type VisibilityFilter = "all" | "public" | "private";
type ArchiveFilter = "all" | "tar.gz" | "none";

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export default function FilesPage() {
  const [search, setSearch] = useState("");
  const [glob, setGlob] = useState("");
  const [tag, setTag] = useState("");
  const [visibility, setVisibility] = useState<VisibilityFilter>("all");
  const [archive, setArchive] = useState<ArchiveFilter>("all");
  const [pager, setPager] = useState(initialPager);
  const [uploadOpen, setUploadOpen] = useState(false);

  const debouncedSearch = useDebounced(search, 250);
  const debouncedGlob = useDebounced(glob, 250);
  const debouncedTag = useDebounced(tag, 250);

  // Any filter change restarts from the first page.
  useEffect(() => {
    setPager(initialPager());
  }, [debouncedSearch, debouncedGlob, debouncedTag, visibility, archive]);

  const query = useMemo(
    () => ({
      q: debouncedSearch || undefined,
      name: debouncedGlob || undefined,
      tags: debouncedTag ? [debouncedTag] : [],
      visibility: visibility === "all" ? undefined : visibility,
      archive: archive === "all" ? undefined : archive,
      limit: PAGE_SIZE,
      cursor: pager.cursor,
    }),
    [debouncedSearch, debouncedGlob, debouncedTag, visibility, archive, pager],
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
            className="button"
            onClick={() => {
              list.reload();
              system.reload();
            }}
          >
            Refresh
          </button>
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
        <div className="segment" role="group" aria-label="Archive filter">
          {(["all", "tar.gz", "none"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={archive === option}
              onClick={() => setArchive(option)}
            >
              {option === "all" ? "Any" : option}
            </button>
          ))}
        </div>
        <span className="filter-spacer" />
        <span className="filter-note">
          newest first · glob is SQLite GLOB · archive is upload metadata
          {list.lastSuccessAt !== null
            ? ` · updated ${formatUtcDateTime(new Date(list.lastSuccessAt).toISOString())}`
            : ""}
        </span>
      </div>

      <StaleBanner
        status={list.data ? list.status : "ready"}
        message={list.message}
        lastSuccessAt={list.lastSuccessAt}
        onRetry={list.reload}
      />

      {list.data ? (
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
                      {/* title + aria-label expose the full untruncated name;
                          the id line keeps similarly prefixed rows
                          distinguishable when narrow screens truncate. */}
                      <Link
                        href={`/admin/files/${file.id}`}
                        title={file.name}
                        aria-label={file.name}
                      >
                        <span className="cell-name-text">{file.name}</span>
                        <span className="cell-name-id" aria-hidden>
                          {file.id}
                        </span>
                      </Link>
                    </td>
                    <td className="cell-size">{formatBytes(file.size)}</td>
                    <td className="cell-mime cell-optional">
                      {file.mime_type}
                    </td>
                    <td className="cell-tags cell-optional">
                      {file.tags.join(" ") || "—"}
                    </td>
                    <td className="cell-vis">
                      <VisibilityLabel visibility={file.visibility} />
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
          status={list.status === "ready" ? "loading" : list.status}
          message={list.message}
          onRetry={list.reload}
        />
      )}

      <div className="pagination-footer">
        <span>
          {list.data
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
