"use client";

import Link from "next/link";

import { adminApi, useAdminData } from "@/admin/client";
import { LoadFallback } from "@/admin/components/LoadFallback";
import { formatBytes, formatListTimestamp } from "@/admin/format";

// The inspector needs an object; this page offers the newest objects to pick.
export default function InspectorIndexPage() {
  const recent = useAdminData(() => adminApi.listFiles({ limit: 8 }), []);

  return (
    <main className="admin-main">
      <div className="page-header">
        <div>
          <h1 className="page-title">Inspector</h1>
          <p className="page-subtitle">
            no object selected — pick one below or from{" "}
            <Link className="panel-link" href="/admin/files">
              Files
            </Link>
          </p>
        </div>
      </div>
      {recent.status === "ready" && recent.data ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" style={{ textAlign: "right" }}>
                  Size
                </th>
                <th scope="col" style={{ textAlign: "right" }}>
                  Uploaded
                </th>
              </tr>
            </thead>
            <tbody>
              {recent.data.items.map((file) => (
                <tr key={file.id}>
                  <td className="cell-name">
                    <Link href={`/admin/files/${file.id}`}>{file.name}</Link>
                  </td>
                  <td className="cell-size">{formatBytes(file.size)}</td>
                  <td className="cell-time">
                    {formatListTimestamp(file.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <LoadFallback
          status={recent.status === "ready" ? "loading" : recent.status}
          message={recent.message}
          onRetry={recent.reload}
        />
      )}
    </main>
  );
}
