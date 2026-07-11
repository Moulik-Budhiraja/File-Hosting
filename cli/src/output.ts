import type { FileMetadata, Streams } from "./types.js";
import { CliError, EXIT } from "./errors.js";

export type OutputMode = "human" | "json" | "jsonl" | "ids";

export function chooseOutputMode(flags: {
  json?: boolean;
  jsonl?: boolean;
  ids?: boolean;
  id?: boolean;
  null?: boolean;
}): OutputMode {
  const selected = [flags.json, flags.jsonl, flags.ids || flags.id].filter(Boolean).length;
  if (selected > 1) {
    throw new CliError("Choose only one of --json, --jsonl, or --ids/--id", EXIT.usage, "OUTPUT_CONFLICT");
  }
  if (flags.null && !(flags.ids || flags.id)) {
    throw new CliError("--null requires --ids or --id", EXIT.usage, "OUTPUT_CONFLICT");
  }
  if (flags.json) return "json";
  if (flags.jsonl) return "jsonl";
  if (flags.ids || flags.id) return "ids";
  return "human";
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unit = "B";
  for (const candidate of units) {
    size /= 1024;
    unit = candidate;
    if (size < 1024) break;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`;
}

export function printItems(
  streams: Streams,
  items: FileMetadata[],
  mode: OutputMode,
  nullDelimited = false,
): void {
  if (mode === "json") {
    streams.stdout.write(`${JSON.stringify(items)}\n`);
    return;
  }
  if (mode === "jsonl") {
    for (const item of items) streams.stdout.write(`${JSON.stringify(item)}\n`);
    return;
  }
  if (mode === "ids") {
    const delimiter = nullDelimited ? "\0" : "\n";
    for (const item of items) streams.stdout.write(`${item.id}${delimiter}`);
    return;
  }
  if (items.length === 0) {
    streams.stdout.write("No files found.\n");
    return;
  }
  const rows = items.map((item) => [
    item.id,
    item.name,
    formatBytes(item.size),
    item.visibility,
    (item.tags ?? []).join(", "),
  ]);
  const headers = ["ID", "NAME", "SIZE", "VISIBILITY", "TAGS"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const line = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  streams.stdout.write(`${line(headers)}\n`);
  for (const row of rows) streams.stdout.write(`${line(row)}\n`);
}

export function printInfo(streams: Streams, item: FileMetadata, json: boolean): void {
  if (json) {
    streams.stdout.write(`${JSON.stringify(item)}\n`);
    return;
  }
  const labels: Array<[string, string]> = [
    ["ID", item.id],
    ["Name", item.name],
    ["Size", `${formatBytes(item.size)} (${item.size} bytes)`],
    ["Preview", item.preview_url ?? ""],
    ["Raw", item.raw_url ?? ""],
    ["Visibility", item.visibility],
    ["Tags", (item.tags ?? []).join(", ") || "-"],
    ["Archive", item.archive ?? "-"],
  ];
  if (item.mime_type) labels.push(["MIME", item.mime_type]);
  if (item.sha256) labels.push(["SHA-256", item.sha256]);
  if (item.created_at) labels.push(["Uploaded", item.created_at]);
  for (const [label, value] of labels) streams.stdout.write(`${`${label}:`.padEnd(12)} ${value}\n`);
}
