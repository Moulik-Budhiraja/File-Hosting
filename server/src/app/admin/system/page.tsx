"use client";

import { adminApi, useAdminData } from "@/admin/client";
import { LoadFallback } from "@/admin/components/LoadFallback";
import { ProposedBlock } from "@/admin/components/ProposedBlock";
import { formatBytes, formatInteger, formatUptime } from "@/admin/format";

interface StatusRowProps {
  name: string;
  detail: string;
  source?: string;
  state?: "ok" | "on" | "warning" | "danger";
}

function StatusRow({ name, detail, source, state }: StatusRowProps) {
  return (
    <div className="status-row">
      <span className="status-name">{name}</span>
      <span className="status-detail">{detail}</span>
      {source ? <span className="status-source">{source}</span> : null}
      {state ? (
        <span className="status-state">
          <span
            className={`dot ${state === "ok" || state === "on" ? "dot-success" : state === "warning" ? "dot-warning" : "dot-danger"}`}
            aria-hidden
          />
          {state}
        </span>
      ) : null}
    </div>
  );
}

const CLI_COMMANDS = [
  "$ fs upload ./batch.parquet --tag ingest",
  '$ fs list "datasets/**" --json',
  "$ fs find --tag ingest --name '*.parquet'",
  "$ fs info 9f2c41d7",
  "$ fs visibility 9f2c41d7 private",
  "$ fs rm 9f2c41d7",
];

export default function SystemPage() {
  const system = useAdminData(() => adminApi.getSystem(), [], {
    refreshMs: 30_000,
  });
  const info = system.data;

  return (
    <main className="admin-main">
      <div className="page-header">
        <div>
          <h1 className="page-title">System Health &amp; Configuration</h1>
          <p className="page-subtitle">
            {info
              ? `GET /api/system · 200 · node ${info.node}`
              : "waiting for /api/system"}
          </p>
        </div>
        <p className="header-side">config read-only · set via environment</p>
      </div>

      {info ? (
        <div className="system-body">
          <div className="system-left">
            <section className="system-section" aria-label="Runtime">
              <div className="panel-head">
                <h2 className="section-label">Runtime</h2>
              </div>
              <StatusRow
                name="Next.js app server"
                detail={`node ${info.node} · standalone build · up ${formatUptime(info.uptime_seconds)}`}
                state="ok"
              />
              <StatusRow
                name="SQLite metadata DB"
                detail={
                  info.database.db_bytes === null
                    ? "remote libSQL endpoint · ping ok"
                    : `${formatBytes(info.database.db_bytes)} on disk · WAL · ping ok`
                }
                state="ok"
              />
              <StatusRow
                name="Filesystem object store"
                detail={`${formatBytes(info.storage.free_bytes)} free · read-write`}
                state="ok"
              />
            </section>

            <section
              className="system-section"
              aria-label="Storage accounting and limits"
            >
              <div className="panel-head">
                <h2 className="section-label">
                  Storage accounting &amp; limits
                </h2>
              </div>
              <StatusRow
                name="object_bytes"
                detail={`${formatInteger(info.storage.object_bytes)} · ${formatBytes(info.storage.object_bytes)} across ${formatInteger(info.storage.object_count)} objects (${formatInteger(info.storage.public_count)} public · ${formatInteger(info.storage.private_count)} private)`}
                source="from /api/system"
              />
              <StatusRow
                name="db_bytes"
                detail={
                  info.database.db_bytes === null
                    ? "not measurable for remote databases"
                    : `${formatInteger(info.database.db_bytes)} · ${formatBytes(info.database.db_bytes)}`
                }
                source="from /api/system"
              />
              <StatusRow
                name="free_bytes"
                detail={`${formatInteger(info.storage.free_bytes)} · ${formatBytes(info.storage.free_bytes)}${info.storage.free_bytes < info.config.min_free_bytes * 2 ? " · approaching reserve" : ""}`}
                source="from /api/system"
                state={
                  info.storage.free_bytes < info.config.min_free_bytes
                    ? "danger"
                    : info.storage.free_bytes < info.config.min_free_bytes * 2
                      ? "warning"
                      : undefined
                }
              />
              <StatusRow
                name="Upload size limit"
                detail={`${formatBytes(info.config.max_upload_bytes)} per object`}
                source="FS_MAX_UPLOAD_BYTES"
              />
              <StatusRow
                name="Reserved space floor"
                detail={`${formatBytes(info.config.min_free_bytes)} kept free · uploads refused below floor`}
                source="FS_MIN_FREE_BYTES"
              />
            </section>

            <section
              className="system-section"
              aria-label="Write path and access"
            >
              <div className="panel-head">
                <h2 className="section-label">Write path &amp; access</h2>
              </div>
              <StatusRow
                name="Streamed I/O"
                detail="chunked upload/download · sha-256 computed in stream"
                state="on"
              />
              <StatusRow
                name="Atomic placement"
                detail="write to .tmp/*.part → fsync → link into store"
                state="on"
              />
              <StatusRow
                name="Temp-part cleanup"
                detail={`parts older than 24 h removed at startup · ${info.storage.temp_part_count} present now`}
                state="on"
              />
              <StatusRow
                name="Bearer-token auth"
                detail="single shared token · required for writes & private reads"
                state="on"
              />
              <StatusRow
                name="Privacy-preserving 404"
                detail="private objects indistinguishable from missing"
                state="on"
              />
            </section>
          </div>

          <aside className="system-right">
            <section aria-label="Server logs">
              <div className="panel-head">
                <h2 className="section-label">
                  Server logs
                  <small>Proposed · Not implemented</small>
                </h2>
              </div>
              <p
                className="proposed-items"
                style={{ padding: "12px 24px 18px" }}
              >
                logs go to container stdout (docker json-file, 10 MB × 3) —
                there is no log-read API, so nothing can be shown here.
              </p>
            </section>

            <section
              aria-label="CLI operations"
              style={{ borderTop: "1px solid var(--color-hairline)" }}
            >
              <div className="panel-head">
                <h2 className="section-label">CLI operations</h2>
              </div>
              <div className="cli-block">
                {CLI_COMMANDS.map((command) => (
                  <div key={command}>{command}</div>
                ))}
              </div>
            </section>

            <ProposedBlock
              items={[
                "multi-user & RBAC",
                "token-management UI",
                "audit store",
                "log API",
                "historical transfer metrics",
              ]}
            />
          </aside>
        </div>
      ) : (
        <LoadFallback
          status={system.status === "ready" ? "loading" : system.status}
          message={system.message}
          onRetry={system.reload}
        />
      )}
    </main>
  );
}
