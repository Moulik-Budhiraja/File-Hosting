import { formatBytes } from "./format";

export type WarningKind = "free-space" | "temp-parts";

export interface Warning {
  // Stable machine-readable identity; UI highlighting keys off this, never
  // off the human-readable title copy.
  kind: WarningKind;
  severity: "info" | "warning" | "danger";
  title: string;
  detail: string;
}

interface WarningInputs {
  freeBytes: number;
  minFreeBytes: number;
  tempPartCount: number;
}

// Warnings are derived only from facts the server reports; nothing synthetic.
export function deriveWarnings(inputs: WarningInputs): Warning[] {
  const warnings: Warning[] = [];
  const { freeBytes, minFreeBytes, tempPartCount } = inputs;

  if (minFreeBytes > 0 && freeBytes < minFreeBytes) {
    warnings.push({
      kind: "free-space",
      severity: "danger",
      title: "Free space below reserve floor",
      detail: `${formatBytes(freeBytes)} free · reserved-space floor ${formatBytes(minFreeBytes)} · writes refused at floor`,
    });
  } else if (minFreeBytes > 0 && freeBytes < minFreeBytes * 2) {
    warnings.push({
      kind: "free-space",
      severity: "warning",
      title: "Free space nearing reserve floor",
      detail: `${formatBytes(freeBytes)} free · reserved-space floor ${formatBytes(minFreeBytes)} · writes refused at floor`,
    });
  }

  if (tempPartCount > 0) {
    warnings.push({
      kind: "temp-parts",
      severity: "info",
      title: `${tempPartCount} temp .part ${tempPartCount === 1 ? "file" : "files"} present`,
      detail:
        "in-flight or orphaned uploads · parts older than 24 h are removed at startup",
    });
  }

  return warnings;
}
