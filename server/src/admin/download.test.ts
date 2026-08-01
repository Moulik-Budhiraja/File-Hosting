import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUFFERED_DOWNLOAD_LIMIT,
  DownloadTooLargeError,
  downloadFile,
  type DownloadEnvironment,
} from "./download";

function chunkResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

interface WritableRecorder {
  written: Uint8Array[];
  closed: boolean;
  aborted: boolean;
}

function fakePicker(recorder: WritableRecorder) {
  return async () => ({
    createWritable: async () => ({
      write: async (chunk: Uint8Array) => {
        recorder.written.push(chunk);
      },
      close: async () => {
        recorder.closed = true;
      },
      abort: async () => {
        recorder.aborted = true;
      },
    }),
  });
}

describe("downloadFile", () => {
  it("streams to disk via the save-file picker with progress", async () => {
    const recorder: WritableRecorder = {
      written: [],
      closed: false,
      aborted: false,
    };
    const progress: number[] = [];
    const environment: DownloadEnvironment = {
      fetchStream: async () =>
        chunkResponse([new Uint8Array(3), new Uint8Array(5)]),
      fetchBlob: async () => {
        throw new Error("must not buffer when streaming is available");
      },
      showSaveFilePicker: fakePicker(recorder),
      saveBlob: () => {
        throw new Error("must not use the anchor fallback when streaming");
      },
    };
    const outcome = await downloadFile(
      { id: "abc1234", name: "big.bin", size: 8 },
      environment,
      { onProgress: (bytes) => progress.push(bytes) },
    );
    assert.equal(outcome.method, "stream");
    assert.equal(outcome.cancelled, false);
    assert.equal(recorder.closed, true);
    assert.equal(recorder.aborted, false);
    assert.deepEqual(
      recorder.written.map((chunk) => chunk.length),
      [3, 5],
    );
    assert.deepEqual(progress, [3, 8]);
  });

  it("short-circuits a pre-aborted download before picker or response establishment", async () => {
    const controller = new AbortController();
    controller.abort();
    let touched = false;
    const environment: DownloadEnvironment = {
      fetchStream: async () => {
        touched = true;
        return chunkResponse([]);
      },
      fetchBlob: async () => {
        touched = true;
        return new Blob([]);
      },
      showSaveFilePicker: async () => {
        touched = true;
        throw new Error("picker must not open");
      },
      saveBlob: () => {
        touched = true;
      },
    };
    const outcome = await downloadFile(
      { id: "abc1234", name: "big.bin", size: 8 },
      environment,
      { signal: controller.signal },
    );
    assert.deepEqual(outcome, { method: "stream", cancelled: true });
    assert.equal(touched, false);
  });

  it("treats a cancelled save dialog as a no-op, without fetching", async () => {
    let fetched = false;
    const environment: DownloadEnvironment = {
      fetchStream: async () => {
        fetched = true;
        return chunkResponse([]);
      },
      fetchBlob: async () => {
        fetched = true;
        return new Blob([]);
      },
      showSaveFilePicker: async () => {
        throw new DOMException("user cancelled", "AbortError");
      },
      saveBlob: () => undefined,
    };
    const outcome = await downloadFile(
      { id: "abc1234", name: "big.bin", size: 8 },
      environment,
    );
    assert.equal(outcome.cancelled, true);
    assert.equal(fetched, false);
  });

  it("aborts the writable and reports cancellation when the signal fires mid-stream", async () => {
    const recorder: WritableRecorder = {
      written: [],
      closed: false,
      aborted: false,
    };
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(new Uint8Array(4));
        // Cancel after the first chunk is delivered.
        controller.abort();
      },
    });
    const environment: DownloadEnvironment = {
      fetchStream: async () => new Response(stream, { status: 200 }),
      fetchBlob: async () => {
        throw new Error("unused");
      },
      showSaveFilePicker: fakePicker(recorder),
      saveBlob: () => undefined,
    };
    const outcome = await downloadFile(
      { id: "abc1234", name: "big.bin", size: 1024 },
      environment,
      { signal: controller.signal },
    );
    assert.equal(outcome.cancelled, true);
    assert.equal(recorder.aborted, true);
    assert.equal(recorder.closed, false);
  });

  it("keeps explicit signal cancellation non-failing when writable abort cleanup rejects", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(new Uint8Array(4));
        controller.abort();
      },
    });
    const environment: DownloadEnvironment = {
      fetchStream: async () => new Response(stream, { status: 200 }),
      fetchBlob: async () => {
        throw new Error("unused");
      },
      showSaveFilePicker: async () => ({
        createWritable: async () => ({
          write: async () => undefined,
          close: async () => undefined,
          abort: async () => {
            throw new DOMException(
              "writer already closed",
              "InvalidStateError",
            );
          },
        }),
      }),
      saveBlob: () => undefined,
    };

    const outcome = await downloadFile(
      { id: "abc1234", name: "big.bin", size: 1024 },
      environment,
      { signal: controller.signal },
    );
    assert.deepEqual(outcome, { method: "stream", cancelled: true });
  });

  it("cancels while a writable write is pending instead of hanging", async () => {
    const controller = new AbortController();
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const environment: DownloadEnvironment = {
      fetchStream: async () => chunkResponse([new Uint8Array(4)]),
      fetchBlob: async () => {
        throw new Error("unused");
      },
      showSaveFilePicker: async () => ({
        createWritable: async () => ({
          write: async () => {
            markWriteStarted();
            await new Promise(() => undefined);
          },
          close: async () => undefined,
          abort: async () => undefined,
        }),
      }),
      saveBlob: () => undefined,
    };

    const download = downloadFile(
      { id: "abc1234", name: "big.bin", size: 4 },
      environment,
      { signal: controller.signal },
    );
    await writeStarted;
    controller.abort();
    const outcome = await Promise.race([
      download,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 100),
      ),
    ]);
    assert.notEqual(outcome, "timeout");
    assert.deepEqual(outcome, { method: "stream", cancelled: true });
  });

  it("aborts the writable when the stream errors", async () => {
    const recorder: WritableRecorder = {
      written: [],
      closed: false,
      aborted: false,
    };
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new Uint8Array(2));
        streamController.error(new Error("network dropped"));
      },
    });
    const environment: DownloadEnvironment = {
      fetchStream: async () => new Response(stream, { status: 200 }),
      fetchBlob: async () => {
        throw new Error("unused");
      },
      showSaveFilePicker: fakePicker(recorder),
      saveBlob: () => undefined,
    };
    await assert.rejects(
      downloadFile({ id: "abc1234", name: "big.bin", size: 1024 }, environment),
      /network dropped/,
    );
    assert.equal(recorder.aborted, true);
  });

  it("falls back to a buffered blob for small files without the picker", async () => {
    const saved: { blob?: Blob; name?: string } = {};
    const environment: DownloadEnvironment = {
      fetchStream: async () => {
        throw new Error("unused");
      },
      fetchBlob: async () => new Blob(["small"]),
      saveBlob: (blob, name) => {
        saved.blob = blob;
        saved.name = name;
      },
    };
    const outcome = await downloadFile(
      { id: "abc1234", name: "small.txt", size: 5 },
      environment,
    );
    assert.equal(outcome.method, "buffer");
    assert.equal(saved.name, "small.txt");
    assert.equal(await saved.blob?.text(), "small");
  });

  // Finding 2: ordinary cancellation must be a normalized non-error outcome
  // in EVERY phase — response establishment, createWritable, stream I/O, and
  // the buffered fallback — while real failures keep throwing.
  it("treats an abort during response establishment as cancellation, not failure", async () => {
    const controller = new AbortController();
    const environment: DownloadEnvironment = {
      fetchStream: async (_id, options) => {
        controller.abort();
        throw new DOMException(
          "The user aborted a request.",
          options.signal?.aborted ? "AbortError" : "AbortError",
        );
      },
      fetchBlob: async () => {
        throw new Error("unused");
      },
      showSaveFilePicker: async () => ({
        createWritable: async () => {
          throw new Error("must not open a writable for an aborted response");
        },
      }),
      saveBlob: () => undefined,
    };
    const outcome = await downloadFile(
      { id: "abc1234", name: "big.bin", size: 8 },
      environment,
      { signal: controller.signal },
    );
    assert.equal(outcome.method, "stream");
    assert.equal(outcome.cancelled, true);
  });

  it("treats an abort during createWritable as cancellation and cancels the response", async () => {
    let bodyCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const environment: DownloadEnvironment = {
      fetchStream: async () => new Response(stream, { status: 200 }),
      fetchBlob: async () => {
        throw new Error("unused");
      },
      showSaveFilePicker: async () => ({
        createWritable: async () => {
          throw new DOMException("cancelled", "AbortError");
        },
      }),
      saveBlob: () => undefined,
    };
    const outcome = await downloadFile(
      { id: "abc1234", name: "big.bin", size: 4 },
      environment,
    );
    assert.equal(outcome.cancelled, true);
    assert.equal(bodyCancelled, true);
  });

  it("treats an abort during the buffered fallback fetch as cancellation", async () => {
    const controller = new AbortController();
    const environment: DownloadEnvironment = {
      fetchStream: async () => {
        throw new Error("unused");
      },
      fetchBlob: async () => {
        controller.abort();
        throw new DOMException("The user aborted a request.", "AbortError");
      },
      saveBlob: () => {
        throw new Error("must not save after cancellation");
      },
    };
    const outcome = await downloadFile(
      { id: "abc1234", name: "small.txt", size: 5 },
      environment,
      { signal: controller.signal },
    );
    assert.equal(outcome.method, "buffer");
    assert.equal(outcome.cancelled, true);
  });

  it("treats fallback body-assembly errors after signal abort as cancellation", async () => {
    const controller = new AbortController();
    const environment: DownloadEnvironment = {
      fetchStream: async () => {
        throw new Error("unused");
      },
      fetchBlob: async () => {
        controller.abort();
        // Chromium can surface a body-stream TypeError rather than AbortError
        // after the request signal has already transitioned to aborted.
        throw new TypeError("BodyStreamBuffer was aborted");
      },
      saveBlob: () => {
        throw new Error("must not save after cancellation");
      },
    };
    const outcome = await downloadFile(
      { id: "abc1234", name: "small.txt", size: 5 },
      environment,
      { signal: controller.signal },
    );
    assert.deepEqual(outcome, { method: "buffer", cancelled: true });
  });

  it("recognizes cross-realm abort errors that are not DOMException instances", async () => {
    const abortLike = new Error("This operation was aborted");
    abortLike.name = "AbortError";
    const environment: DownloadEnvironment = {
      fetchStream: async () => {
        throw abortLike;
      },
      fetchBlob: async () => {
        throw new Error("unused");
      },
      showSaveFilePicker: async () => ({
        createWritable: async () => {
          throw new Error("unreached");
        },
      }),
      saveBlob: () => undefined,
    };
    const outcome = await downloadFile(
      { id: "abc1234", name: "big.bin", size: 8 },
      environment,
    );
    assert.equal(outcome.cancelled, true);
  });

  it("preserves real establishment and fallback errors", async () => {
    const failingStream: DownloadEnvironment = {
      fetchStream: async () => {
        throw new Error("TLS handshake failed");
      },
      fetchBlob: async () => {
        throw new Error("unused");
      },
      showSaveFilePicker: async () => ({
        createWritable: async () => {
          throw new Error("unreached");
        },
      }),
      saveBlob: () => undefined,
    };
    await assert.rejects(
      downloadFile({ id: "abc1234", name: "a.bin", size: 8 }, failingStream),
      /TLS handshake failed/,
    );
    const failingBlob: DownloadEnvironment = {
      fetchStream: async () => {
        throw new Error("unused");
      },
      fetchBlob: async () => {
        throw new Error("HTTP 500");
      },
      saveBlob: () => undefined,
    };
    await assert.rejects(
      downloadFile({ id: "abc1234", name: "a.bin", size: 8 }, failingBlob),
      /HTTP 500/,
    );
  });

  it("refuses to buffer a 10 GiB object before any network request", async () => {
    let touchedNetwork = false;
    const environment: DownloadEnvironment = {
      fetchStream: async () => {
        touchedNetwork = true;
        return chunkResponse([]);
      },
      fetchBlob: async () => {
        touchedNetwork = true;
        return new Blob([]);
      },
      saveBlob: () => undefined,
    };
    await assert.rejects(
      downloadFile(
        // Simulated size only — no bytes are materialized in this test.
        { id: "abc1234", name: "huge.bin", size: 10 * 1024 ** 3 },
        environment,
      ),
      (error: unknown) => error instanceof DownloadTooLargeError,
    );
    assert.equal(touchedNetwork, false);
    assert.ok(BUFFERED_DOWNLOAD_LIMIT <= 512 * 1024 * 1024);
  });
});
