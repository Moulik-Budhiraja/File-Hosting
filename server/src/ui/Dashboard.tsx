"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "@/lib/api";
import { formatDateTime, formatSize } from "@/lib/format";
import type { FileMetadata } from "@/lib/types";

export interface SystemSnapshot {
  version: string;
  node: string;
  uptime_seconds: number;
  storage: {
    volume_total_bytes: number;
    volume_used_bytes: number;
    free_bytes: number;
    object_bytes: number;
    object_count: number;
    public_count: number;
    protected_count: number;
    private_count: number;
    temp_part_count: number;
  };
  database: { db_bytes: number | null };
  transfers: Array<{
    direction: "upload" | "download";
    name: string;
    bytes: number;
    total_bytes: number | null;
    started_at: string;
  }>;
  config: {
    max_upload_bytes: number;
    min_free_bytes: number;
    public_url: string;
  };
}

type LoadState<T> =
  | { kind: "loading"; data: null }
  | { kind: "ready"; data: T }
  | { kind: "stale"; data: T }
  | { kind: "error"; data: null };

function useLiveData<T>(loader: () => Promise<T>, refreshMs: number) {
  const [state, setState] = useState<LoadState<T>>({
    kind: "loading",
    data: null,
  });
  const inFlight = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const data = await loader();
      if (mounted.current) setState({ kind: "ready", data });
    } catch {
      if (mounted.current) {
        setState((current) =>
          current.data === null
            ? { kind: "error", data: null }
            : { kind: "stale", data: current.data },
        );
      }
    } finally {
      inFlight.current = false;
      if (mounted.current && pending.current) {
        pending.current = false;
        queueMicrotask(() => void load());
      }
    }
  }, [loader]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => {
      mounted.current = false;
      pending.current = false;
      window.clearInterval(timer);
    };
  }, [load, refreshMs]);
  return { state, retry: load };
}

function exactSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return formatSize(bytes);
}

function percent(bytes: number, total: number | null): string {
  return total && total > 0
    ? `${Math.min(100, Math.round((bytes / total) * 100))}%`
    : "—";
}

function InitialFallback({
  title,
  retry,
}: {
  title: string;
  retry: () => void;
}) {
  return (
    <div className="dashboard-fallback" role="alert">
      <p>{title}</p>
      <button type="button" className="button" onClick={retry}>
        Retry
      </button>
    </div>
  );
}

export function LiveOperations({ refreshMs = 1_000 }: { refreshMs?: number }) {
  const loadSystem = useCallback(
    () => apiFetch<SystemSnapshot>("/api/system"),
    [],
  );
  const loadRecent = useCallback(
    () => apiFetch<{ items: FileMetadata[] }>("/api/files?limit=12"),
    [],
  );
  const system = useLiveData(loadSystem, refreshMs);
  const recent = useLiveData(loadRecent, 30_000);
  const info = system.state.data;
  if (!info && system.state.kind === "error") {
    return (
      <InitialFallback
        title="Couldn’t load live operations"
        retry={system.retry}
      />
    );
  }
  if (!info)
    return (
      <div className="dashboard-skeleton" role="status">
        Loading…
      </div>
    );

  const nearFloor =
    info.config.min_free_bytes > 0 &&
    info.storage.free_bytes < info.config.min_free_bytes * 2;
  const belowFloor = info.storage.free_bytes < info.config.min_free_bytes;
  const frozen = system.state.kind === "stale";
  const used =
    info.storage.volume_total_bytes > 0
      ? (info.storage.volume_used_bytes / info.storage.volume_total_bytes) * 100
      : 0;

  return (
    <div className="dashboard-view">
      <div className="operations-head">
        <div>
          <h1 className="page-title">Live Operations</h1>
          <p className="page-statline">
            up {Math.floor(info.uptime_seconds / 86400)}d
          </p>
        </div>
        <span className={frozen ? "status-warning" : "status-ok"}>
          {frozen ? "STALE · frozen" : "HEALTHY"}
        </span>
      </div>
      {frozen ? (
        <div className="dashboard-statebar" role="status">
          STALE · last values frozen
          <button
            type="button"
            className="button button-small"
            onClick={system.retry}
          >
            Retry
          </button>
        </div>
      ) : null}
      <section className="storage-strip" aria-label="Storage">
        <div>
          <span>Volume used</span>
          <strong>{exactSize(info.storage.volume_used_bytes)}</strong>
        </div>
        <div>
          <span>Free</span>
          <strong className={nearFloor ? "status-warning" : undefined}>
            {exactSize(info.storage.free_bytes)}
          </strong>
        </div>
        <div>
          <span>Metadata DB</span>
          <strong>
            {info.database.db_bytes === null
              ? "remote"
              : exactSize(info.database.db_bytes)}
          </strong>
        </div>
        <div>
          <span>Objects</span>
          <strong>{info.storage.object_count.toLocaleString("en-US")}</strong>
        </div>
        <small>
          object bytes {exactSize(info.storage.object_bytes)} ·{" "}
          {used.toFixed(1)}% used
        </small>
        <div className="capacity-line">
          <span style={{ width: `${used}%` }} />
        </div>
      </section>
      <div className="operations-grid">
        <div>
          <section className="dashboard-section" aria-label="Active transfers">
            <h2 className="section-label">
              Active transfers · {frozen ? "frozen" : info.transfers.length}
            </h2>
            {frozen || info.transfers.length === 0 ? (
              <p className="dashboard-empty">
                {frozen ? "Live view unavailable" : "No active transfers"}
              </p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Object</th>
                    <th className="cell-num">Transferred</th>
                    <th>Progress</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {info.transfers.map((transfer) => (
                    <tr key={`${transfer.started_at}-${transfer.name}`}>
                      <td className="cell-strong">
                        {transfer.direction === "upload" ? "↑" : "↓"}{" "}
                        {transfer.name}
                      </td>
                      <td className="cell-mono cell-num">
                        {exactSize(transfer.bytes)}
                        {transfer.total_bytes
                          ? ` / ${exactSize(transfer.total_bytes)}`
                          : ""}
                      </td>
                      <td className="cell-mono">
                        {percent(transfer.bytes, transfer.total_bytes)}
                      </td>
                      <td className="cell-mono">
                        {transfer.direction === "upload"
                          ? "uploading"
                          : "downloading"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="dashboard-section" aria-label="Recent files">
            <div className="section-head">
              <h2 className="section-label">Recent files</h2>
              <Link href="/files">all files →</Link>
            </div>
            {recent.state.kind === "loading" ? (
              <p className="dashboard-empty" role="status">
                Loading files…
              </p>
            ) : recent.state.kind === "error" ? (
              <div className="dashboard-empty" role="alert">
                Files unavailable{" "}
                <button
                  type="button"
                  className="button button-small"
                  onClick={recent.retry}
                >
                  Retry files
                </button>
              </div>
            ) : recent.state.data.items.length ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="cell-num">Size</th>
                    <th className="col-desktop">MIME</th>
                    <th>Vis</th>
                    <th className="cell-num col-desktop">Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.state.data.items.map((file) => (
                    <tr key={file.id}>
                      <td className="cell-strong">
                        <Link
                          href={`/files?sel=${encodeURIComponent(file.id)}`}
                        >
                          {file.name}
                        </Link>
                      </td>
                      <td className="cell-num cell-mono">
                        {formatSize(file.size)}
                      </td>
                      <td className="cell-mono col-desktop">
                        {file.mime_type}
                      </td>
                      <td className="cell-mono">{file.visibility}</td>
                      <td className="cell-num cell-mono col-desktop">
                        {formatDateTime(file.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="dashboard-empty">
                {recent.state.kind === "stale" ? "Files frozen" : "No files"}
              </p>
            )}
          </section>
        </div>
        <aside
          className="dashboard-section warnings"
          aria-label="Active warnings"
        >
          <h2 className="section-label">Active warnings</h2>
          {nearFloor ? (
            <div className={belowFloor ? "warning-danger" : "warning-item"}>
              <strong>
                {belowFloor
                  ? "Free space below reserve floor"
                  : "Free space nearing reserve floor"}
              </strong>
              <span>
                {exactSize(info.storage.free_bytes)} free · floor{" "}
                {exactSize(info.config.min_free_bytes)}
              </span>
            </div>
          ) : (
            <p className="dashboard-empty">None</p>
          )}
          {info.storage.temp_part_count > 0 ? (
            <div className="warning-item">
              <strong>Temporary parts present</strong>
              <span>{info.storage.temp_part_count} files</span>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function StatusLine({
  label,
  value,
  state,
}: {
  label: string;
  value: string;
  state?: "ok" | "warning";
}) {
  return (
    <div className="system-row">
      <span>{label}</span>
      <strong>{value}</strong>
      {state ? (
        <em className={state === "ok" ? "status-ok" : "status-warning"}>
          • {state}
        </em>
      ) : null}
    </div>
  );
}

export function SystemStatus({ refreshMs = 30_000 }: { refreshMs?: number }) {
  const loader = useCallback(() => apiFetch<SystemSnapshot>("/api/system"), []);
  const load = useLiveData(loader, refreshMs);
  const info = load.state.data;
  if (!info && load.state.kind === "error")
    return (
      <InitialFallback title="Couldn’t load system status" retry={load.retry} />
    );
  if (!info)
    return (
      <div className="dashboard-skeleton" role="status">
        Loading…
      </div>
    );
  return (
    <div className="dashboard-view system-view">
      <div className="operations-head">
        <div>
          <h1 className="page-title">System Health &amp; Configuration</h1>
          <p className="page-statline">v{info.version}</p>
        </div>
        <span className="page-header-note">config read-only</span>
      </div>
      {load.state.kind === "stale" ? (
        <div className="dashboard-statebar" role="status" aria-live="polite">
          STALE · values frozen{" "}
          <button className="button button-small" onClick={load.retry}>
            Retry
          </button>
        </div>
      ) : null}
      <section className="system-group">
        <h2 className="section-label">Runtime</h2>
        <StatusLine label="Next.js app server" value={info.node} state="ok" />
        <StatusLine
          label="SQLite metadata DB"
          value={
            info.database.db_bytes === null
              ? "remote"
              : exactSize(info.database.db_bytes)
          }
          state="ok"
        />
        <StatusLine
          label="Filesystem object store"
          value={`${exactSize(info.storage.free_bytes)} free`}
          state="ok"
        />
      </section>
      <section className="system-group">
        <h2 className="section-label">Storage &amp; limits</h2>
        <StatusLine
          label="Objects"
          value={`${info.storage.object_count.toLocaleString("en-US")} · ${info.storage.public_count.toLocaleString("en-US")} public · ${info.storage.protected_count.toLocaleString("en-US")} protected · ${info.storage.private_count.toLocaleString("en-US")} private`}
        />
        <StatusLine
          label="Object bytes"
          value={exactSize(info.storage.object_bytes)}
        />
        <StatusLine
          label="Upload size limit"
          value={`${exactSize(info.config.max_upload_bytes)} per object`}
        />
        <StatusLine
          label="Reserved space floor"
          value={`${exactSize(info.config.min_free_bytes)} kept free`}
          state={
            info.storage.free_bytes < info.config.min_free_bytes * 2
              ? "warning"
              : undefined
          }
        />
      </section>
      <section className="system-group">
        <h2 className="section-label">Write path &amp; access</h2>
        <StatusLine label="Streamed I/O" value="on" state="ok" />
        <StatusLine label="Atomic placement" value="on" state="ok" />
        <StatusLine label="Temp-part cleanup" value="on" state="ok" />
        <StatusLine label="Per-user key auth" value="on" state="ok" />
        <StatusLine label="Privacy-preserving 404" value="on" state="ok" />
      </section>
    </div>
  );
}
