// Keyset-pagination task state in the URL: the current cursor plus a
// BOUNDED backward-history stack, so session expiry + reauth restores not
// just the page but the ability to move back from it. Cursors are opaque
// non-secret base64url tokens; a null entry (the unpaginated first page)
// encodes as "~", which cannot appear in a cursor.

export const PREV_HISTORY_LIMIT = 8;

const NULL_ENTRY = "~";

export function encodePrevCursors(prev: Array<string | null>): string | null {
  if (prev.length === 0) return null;
  return prev
    .slice(-PREV_HISTORY_LIMIT)
    .map((cursor) => cursor ?? NULL_ENTRY)
    .join(",");
}

export function decodePrevCursors(value: string | null): Array<string | null> {
  if (!value) return [];
  return value
    .split(",")
    .slice(-PREV_HISTORY_LIMIT)
    .map((entry) => (entry === NULL_ENTRY ? null : entry))
    .filter((entry) => entry === null || entry.length > 0);
}

export function boundPrevCursors(
  prev: Array<string | null>,
): Array<string | null> {
  return prev.slice(-PREV_HISTORY_LIMIT);
}

export function readTaskParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}
