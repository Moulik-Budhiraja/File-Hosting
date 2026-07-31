"use client";

import type { SystemResponse } from "../api";
import type { LoadStatus } from "../load-state";
import { formatBytes, formatUtcDateTime } from "../format";

export type TransferEntry = SystemResponse["transfers"][number];

interface TransfersPanelProps {
  status: LoadStatus;
  transfers: TransferEntry[] | null;
  lastSuccessAt: number | null;
}

// Live transfer table for the Overview page. Transfers are ephemeral,
// in-process state: they are only true while the poll that reported them is
// current, so retained rows after a failed refresh must never render as
// "streaming".
export function TransfersPanel({
  status,
  transfers,
  lastSuccessAt,
}: TransfersPanelProps) {
  if (transfers === null) {
    return (
      <p className="warning-detail" style={{ padding: "0 32px 18px" }}>
        unavailable until /api/system responds
      </p>
    );
  }
  if (status !== "ready") {
    // Retained transfer rows are ephemeral by definition — a failed or
    // in-flight refresh means nothing can truthfully be called "streaming".
    return (
      <p className="warning-detail" style={{ padding: "0 32px 18px" }}>
        live transfer view unavailable — the last /api/system refresh did not
        succeed, so in-flight streams cannot be shown
        {lastSuccessAt !== null
          ? ` · last live data ${formatUtcDateTime(new Date(lastSuccessAt).toISOString())}`
          : ""}
      </p>
    );
  }
  if (transfers.length === 0) {
    return (
      <p className="warning-detail" style={{ padding: "0 32px 18px" }}>
        none in flight right now — streamed uploads and downloads appear here
        only while they are active
      </p>
    );
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Object</th>
            <th scope="col" style={{ textAlign: "right" }}>
              Transferred
            </th>
            <th scope="col" className="cell-optional">
              Progress
            </th>
            <th scope="col">Stage</th>
          </tr>
        </thead>
        <tbody>
          {transfers.map((transfer, index) => (
            <tr key={`${transfer.started_at}-${index}`}>
              <td className="cell-name">
                <span aria-hidden>
                  {transfer.direction === "upload" ? "↑ " : "↓ "}
                </span>
                {transfer.name}
              </td>
              <td className="cell-size">
                {formatBytes(transfer.bytes)}
                {transfer.total_bytes !== null
                  ? ` / ${formatBytes(transfer.total_bytes)}`
                  : ""}
              </td>
              <td className="cell-mime cell-optional">
                {transfer.total_bytes
                  ? `${Math.min(100, Math.round((transfer.bytes / transfer.total_bytes) * 100))}%`
                  : "size unknown"}
              </td>
              <td className="cell-vis">
                {transfer.direction === "upload"
                  ? "streaming → .part"
                  : "streaming → client"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
