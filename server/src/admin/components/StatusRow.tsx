"use client";

export interface StatusRowProps {
  name: string;
  detail: string;
  source?: string;
  state?: "ok" | "on" | "warning" | "danger";
  fresh?: boolean;
}

// A System-page capability/status row. Success cues ("ok"/"on" with a green
// dot) are earned by the CURRENT successful /api/system response only.
export function StatusRow({
  name,
  detail,
  source,
  state,
  fresh = true,
}: StatusRowProps) {
  const success = state === "ok" || state === "on";
  // A stale view downgrades success cues to neutral "configured · unverified":
  // the capability is still configured, but nothing current proves it works.
  const shownState = success && !fresh ? undefined : state;
  return (
    <div className="status-row">
      <span className="status-name">{name}</span>
      <span className="status-detail">{detail}</span>
      {source ? <span className="status-source">{source}</span> : null}
      {shownState ? (
        <span className="status-state">
          <span
            className={`dot ${shownState === "ok" || shownState === "on" ? "dot-success" : shownState === "warning" ? "dot-warning" : "dot-danger"}`}
            aria-hidden
          />
          {shownState}
        </span>
      ) : success && !fresh ? (
        <span className="status-state status-state-muted">
          <span className="dot dot-muted" aria-hidden />
          configured · unverified
        </span>
      ) : null}
    </div>
  );
}
