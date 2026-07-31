// Authenticated download strategies. Private raw reads require the bearer
// header, so downloads cannot be plain anchor navigations. Where the File
// System Access API exists, the response body is streamed straight to disk —
// never materialized as one Blob — with progress and cancellation. Browsers
// without it get a truthful bounded fallback: small objects are buffered, and
// anything above BUFFERED_DOWNLOAD_LIMIT is refused BEFORE any bytes move,
// because buffering a supported 10 GiB object would exhaust renderer memory.

export const BUFFERED_DOWNLOAD_LIMIT = 256 * 1024 * 1024;

export class DownloadTooLargeError extends Error {
  constructor(size: number) {
    super(
      `This browser cannot stream downloads to disk, and ${size} bytes is too large to buffer in memory (limit ${BUFFERED_DOWNLOAD_LIMIT} bytes). Use the CLI (fs down <id>) or a browser with the File System Access API.`,
    );
    this.name = "DownloadTooLargeError";
  }
}

interface WritableLike {
  write(chunk: Uint8Array): Promise<unknown>;
  close(): Promise<unknown>;
  abort(reason?: unknown): Promise<unknown>;
}

interface SaveFileHandleLike {
  createWritable(): Promise<WritableLike>;
}

export interface DownloadEnvironment {
  fetchStream: (
    id: string,
    options: { signal?: AbortSignal },
  ) => Promise<Response>;
  fetchBlob: (id: string, options: { signal?: AbortSignal }) => Promise<Blob>;
  showSaveFilePicker?: (options: {
    suggestedName: string;
  }) => Promise<SaveFileHandleLike>;
  saveBlob: (blob: Blob, name: string) => void;
}

export interface DownloadTarget {
  id: string;
  name: string;
  size: number;
}

export interface DownloadOutcome {
  method: "stream" | "buffer";
  cancelled: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function streamToDisk(
  target: DownloadTarget,
  environment: DownloadEnvironment,
  picker: NonNullable<DownloadEnvironment["showSaveFilePicker"]>,
  options: {
    signal?: AbortSignal;
    onProgress?: (bytes: number, totalBytes: number) => void;
  },
): Promise<DownloadOutcome> {
  let handle: SaveFileHandleLike;
  try {
    // The picker runs first (it needs the user gesture); a dismissed dialog
    // is a plain cancellation, not a failure.
    handle = await picker({ suggestedName: target.name });
  } catch (error) {
    if (isAbortError(error)) return { method: "stream", cancelled: true };
    throw error;
  }

  const response = await environment.fetchStream(target.id, {
    signal: options.signal,
  });
  const body = response.body;
  if (!body) {
    throw new Error("The download response had no body to stream");
  }
  const writable = await handle.createWritable();
  const reader = body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  options.signal?.addEventListener("abort", abort);
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (options.signal?.aborted) {
        await writable.abort(new DOMException("cancelled", "AbortError"));
        return { method: "stream", cancelled: true };
      }
      if (done) break;
      await writable.write(value);
      bytes += value.length;
      options.onProgress?.(bytes, target.size);
    }
    await writable.close();
    return { method: "stream", cancelled: false };
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    if (isAbortError(error)) return { method: "stream", cancelled: true };
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function downloadFile(
  target: DownloadTarget,
  environment: DownloadEnvironment,
  options: {
    signal?: AbortSignal;
    onProgress?: (bytes: number, totalBytes: number) => void;
  } = {},
): Promise<DownloadOutcome> {
  if (environment.showSaveFilePicker) {
    return streamToDisk(
      target,
      environment,
      environment.showSaveFilePicker,
      options,
    );
  }
  if (target.size > BUFFERED_DOWNLOAD_LIMIT) {
    throw new DownloadTooLargeError(target.size);
  }
  const blob = await environment.fetchBlob(target.id, {
    signal: options.signal,
  });
  environment.saveBlob(blob, target.name);
  return { method: "buffer", cancelled: false };
}

// The real browser environment, kept separate so the strategy above stays
// unit-testable without a DOM.
export function browserDownloadEnvironment(api: {
  fetchRawStream: (
    id: string,
    options?: { signal?: AbortSignal },
  ) => Promise<Response>;
  fetchRawBlob: (
    id: string,
    options?: { signal?: AbortSignal },
  ) => Promise<Blob>;
}): DownloadEnvironment {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: DownloadEnvironment["showSaveFilePicker"];
    }
  ).showSaveFilePicker;
  return {
    fetchStream: (id, options) => api.fetchRawStream(id, options),
    fetchBlob: (id, options) => api.fetchRawBlob(id, options),
    // Bind the picker to window: unbound invocation throws in Chromium.
    showSaveFilePicker: picker ? picker.bind(window) : undefined,
    saveBlob: (blob, name) => {
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    },
  };
}
