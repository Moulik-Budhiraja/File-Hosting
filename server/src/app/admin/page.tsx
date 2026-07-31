"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { adminApi, useAdminData } from "@/admin/client";
import { LoadFallback } from "@/admin/components/LoadFallback";
import { StaleBanner } from "@/admin/components/StaleBanner";
import { ProposedBlock } from "@/admin/components/ProposedBlock";
import { StateBanner } from "@/admin/components/StateBanner";
import { TransfersPanel } from "@/admin/components/TransfersPanel";
import { VisibilityLabel } from "@/admin/components/VisibilityLabel";
import {
  formatBytes,
  formatInteger,
  formatRecentTimestamp,
  formatUptime,
  formatUtcDateTime,
} from "@/admin/format";
import { deriveWarnings } from "@/admin/warnings";

const RECENT_LIMIT = 12;

export default function OverviewPage() {
  const system = useAdminData(() => adminApi.getSystem(), [], {
    // Current transfers are ephemeral; a 30 s poll made the "live" table miss
    // ordinary uploads entirely. One second keeps this in-process view useful.
    refreshMs: 1_000,
  });
  const recent = useAdminData(
    () => adminApi.listFiles({ limit: RECENT_LIMIT }),
    [],
    { refreshMs: 30_000 },
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const info = system.data;
  const warnings = info
    ? deriveWarnings({
        freeBytes: info.storage.free_bytes,
        minFreeBytes: info.config.min_free_bytes,
        tempPartCount: info.storage.temp_part_count,
      })
    : [];
  const reachableBytes = info
    ? info.storage.object_bytes + info.storage.free_bytes
    : 0;
  const usedShare =
    info && reachableBytes > 0 ? info.storage.object_bytes / reachableBytes : 0;
  const healthy = system.status === "ready";

  return (
    <main className="admin-main">
      <div className="page-header">
        <div>
          <h1 className="page-title">Live Operations</h1>
          <p className="page-subtitle">
            {info
              ? `up ${formatUptime(info.uptime_seconds)} · ${formatUtcDateTime(new Date(now).toISOString())}`
              : formatUtcDateTime(new Date(now).toISOString())}
          </p>
        </div>
        <p className="header-side">
          <span
            className={`dot ${healthy ? "dot-success" : system.status === "loading" ? "dot-muted" : "dot-danger"}`}
            aria-hidden
          />
          {healthy ? (
            <>
              <span className="text-success">HEALTHY</span>
              <span>· store writable · db reachable</span>
            </>
          ) : system.status === "loading" ? (
            <span>checking …</span>
          ) : (
            <span className="text-danger">system endpoint {system.status}</span>
          )}
        </p>
      </div>

      <StaleBanner
        status={info ? system.status : "ready"}
        message={system.message}
        lastSuccessAt={system.lastSuccessAt}
        onRetry={system.reload}
      />

      {info ? (
        <section className="storage-band" aria-label="Storage">
          <div className="storage-figures">
            <div>
              <p className="figure-label">Storage used</p>
              <p className="figure-value">
                {formatBytes(info.storage.object_bytes)}
              </p>
            </div>
            <div>
              <p className="figure-label">Free</p>
              <p
                className={`figure-value ${
                  warnings.some(
                    (warning) =>
                      warning.severity !== "info" &&
                      warning.kind === "free-space",
                  )
                    ? "text-warning"
                    : ""
                }`}
              >
                {formatBytes(info.storage.free_bytes)}
              </p>
            </div>
            <div>
              <p className="figure-label">Metadata DB</p>
              <p className="figure-value">
                {info.database.db_bytes === null
                  ? "remote"
                  : formatBytes(info.database.db_bytes)}
              </p>
            </div>
            <div>
              <p className="figure-label">Objects</p>
              <p className="figure-value">
                {formatInteger(info.storage.object_count)}
              </p>
            </div>
            <p className="figure-note">
              objects + free ≈ {formatBytes(reachableBytes)} ·{" "}
              {(usedShare * 100).toFixed(1)}% used
            </p>
          </div>
          <div className="capacity-bar" aria-hidden>
            <span style={{ width: `${Math.max(usedShare * 100, 0.5)}%` }} />
          </div>
        </section>
      ) : (
        <LoadFallback
          status={system.status === "ready" ? "loading" : system.status}
          message={system.message}
          onRetry={system.reload}
        />
      )}

      <div className="overview-body">
        <div className="overview-left">
          <section aria-label="Active transfers">
            <div className="panel-head">
              <h2 className="section-label">
                Active transfers
                <small>
                  {info && healthy
                    ? `${info.transfers.length} ${info.transfers.length === 1 ? "stream" : "streams"} · this server process · no history kept`
                    : info
                      ? "live view unavailable — refresh failed"
                      : "awaiting /api/system"}
                </small>
              </h2>
            </div>
            <TransfersPanel
              status={system.status}
              transfers={info ? info.transfers : null}
              lastSuccessAt={system.lastSuccessAt}
            />
          </section>

          <section
            aria-label="Recent files"
            style={{ borderTop: "1px solid var(--color-hairline)" }}
          >
            <div className="panel-head">
              <h2 className="section-label">Recent files</h2>
              <Link className="panel-link" href="/admin/files">
                all files →
              </Link>
            </div>
            <StaleBanner
              status={recent.data ? recent.status : "ready"}
              message={recent.message}
              lastSuccessAt={recent.lastSuccessAt}
              onRetry={recent.reload}
            />
            {recent.data ? (
              recent.data.items.length === 0 ? (
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
                        <th scope="col">Vis</th>
                        <th scope="col" style={{ textAlign: "right" }}>
                          Uploaded
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.data.items.map((file) => (
                        <tr key={file.id}>
                          <td className="cell-name">
                            <Link href={`/admin/files/${file.id}`}>
                              {file.name}
                            </Link>
                          </td>
                          <td className="cell-size">
                            {formatBytes(file.size)}
                          </td>
                          <td className="cell-mime cell-optional">
                            {file.mime_type}
                          </td>
                          <td className="cell-vis">
                            <VisibilityLabel visibility={file.visibility} />
                          </td>
                          <td className="cell-time">
                            {formatRecentTimestamp(file.created_at, now)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : (
              <LoadFallback
                status={recent.status === "ready" ? "loading" : recent.status}
                message={recent.message}
                onRetry={recent.reload}
              />
            )}
          </section>
        </div>

        <aside className="overview-right">
          <section aria-label="Active warnings">
            <div className="panel-head">
              <h2 className="section-label">
                Active warnings{" "}
                {warnings.length > 0 ? (
                  <small className="text-warning">{warnings.length}</small>
                ) : null}
              </h2>
            </div>
            {info ? (
              warnings.length === 0 ? (
                <p
                  className="warning-detail"
                  style={{ padding: "12px 24px 18px" }}
                >
                  none — free space is above twice the reserve floor and no temp
                  parts linger
                </p>
              ) : (
                <ul>
                  {warnings.map((warning) => (
                    <li className="warning-item" key={warning.title}>
                      <span
                        className={`dot dot-${warning.severity === "info" ? "muted" : warning.severity}`}
                        aria-hidden
                      />
                      <div>
                        <p className="warning-title">{warning.title}</p>
                        <p className="warning-detail">{warning.detail}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <p
                className="warning-detail"
                style={{ padding: "12px 24px 18px" }}
              >
                unavailable until /api/system responds
              </p>
            )}
          </section>

          <section
            aria-label="Housekeeping"
            style={{ borderTop: "1px solid var(--color-hairline)" }}
          >
            <div className="panel-head">
              <h2 className="section-label">Housekeeping</h2>
            </div>
            <dl>
              <div className="kv-row">
                <dt>Temp .part files</dt>
                <dd>
                  {info ? `${info.storage.temp_part_count} present` : "—"}
                </dd>
              </div>
              <div className="kv-row">
                <dt>Temp-part cleanup</dt>
                <dd>
                  parts older than 24 h<small>removed at startup</small>
                </dd>
              </div>
              <div className="kv-row">
                <dt>Atomic placement</dt>
                <dd>
                  .part → fsync → link<small>never partial in store</small>
                </dd>
              </div>
            </dl>
            <ProposedBlock
              items={[
                "historical transfer metrics",
                "cleanup-sweep timestamps",
                "log rotation status",
              ]}
            />
          </section>
        </aside>
      </div>
    </main>
  );
}
