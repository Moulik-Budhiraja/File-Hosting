"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { adminApi, useAdminData } from "@/admin/client";
import { type FileEntry } from "@/admin/api";
import { ConfirmDialog } from "@/admin/components/ConfirmDialog";
import { VisibilityLabel } from "@/admin/components/VisibilityLabel";
import { LoadFallback } from "@/admin/components/LoadFallback";
import { browserDownloadEnvironment, downloadFile } from "@/admin/download";
import {
  formatBytes,
  formatExactBytes,
  formatUtcDateTime,
} from "@/admin/format";

const TEXT_PREVIEW_LIMIT = 256 * 1024;
const IMAGE_PREVIEW_LIMIT = 4 * 1024 * 1024;

function isTextLike(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/x-yaml" ||
    mime === "application/xml"
  );
}

function Preview({ file }: { file: FileEntry }) {
  const [text, setText] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const textEligible = isTextLike(file.mime_type);
  const imageEligible =
    file.mime_type.startsWith("image/") && file.size <= IMAGE_PREVIEW_LIMIT;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    // Aborting on cleanup stops in-flight preview fetches on unmount or
    // object change, so a stable object triggers exactly one request.
    const controller = new AbortController();
    setText(null);
    setImageUrl(null);
    setFailed(false);

    if (textEligible && file.size === 0) {
      // A zero-byte text object is a truthful empty preview, not a fetch —
      // and never a malformed "bytes=0--1" range request.
      setText("");
    } else if (textEligible) {
      adminApi
        .fetchRawText(file.id, Math.min(file.size, TEXT_PREVIEW_LIMIT), {
          signal: controller.signal,
        })
        .then((value) => {
          if (!cancelled) setText(value);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    } else if (imageEligible) {
      adminApi
        .fetchRawBlob(file.id, { signal: controller.signal })
        .then((blob) => {
          objectUrl = URL.createObjectURL(blob);
          if (!cancelled) setImageUrl(objectUrl);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }
    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, file.size, file.visibility, textEligible, imageEligible]);

  if (failed)
    return (
      <p className="preview-placeholder">
        preview fetch failed — use the raw URL below
      </p>
    );
  if (textEligible)
    return text === null ? (
      <p className="preview-placeholder">loading text preview …</p>
    ) : text === "" && file.size === 0 ? (
      <p className="preview-placeholder">
        empty file — 0 bytes, nothing to preview
      </p>
    ) : (
      <pre>
        {text}
        {file.size > TEXT_PREVIEW_LIMIT ? "\n… truncated at 256 KB" : ""}
      </pre>
    );
  if (imageEligible)
    return imageUrl === null ? (
      <p className="preview-placeholder">loading image preview …</p>
    ) : (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={imageUrl} alt={`Preview of ${file.name}`} />
    );
  return (
    <p className="preview-placeholder">
      no inline preview for {file.mime_type} — download or open the raw URL
      below
    </p>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "pending" | "copied" | "failed">(
    "idle",
  );
  return (
    <button
      type="button"
      className={`button button-ghost${state === "failed" ? " text-danger" : ""}`}
      aria-label={label}
      disabled={state === "pending"}
      onClick={() => {
        if (state === "pending") return;
        setState("pending");
        navigator.clipboard
          .writeText(value)
          .then(() => setState("copied"))
          .catch(() => setState("failed"))
          .finally(() => setTimeout(() => setState("idle"), 1_500));
      }}
    >
      {state === "pending"
        ? "copying …"
        : state === "copied"
          ? "copied"
          : state === "failed"
            ? "copy failed"
            : "copy"}
    </button>
  );
}

export default function InspectorPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const load = useAdminData(() => adminApi.getFile(id), [id]);

  // Staged edits — applied in one PATCH by "Save changes".
  const [visibility, setVisibility] = useState<"public" | "private" | null>(
    null,
  );
  const [tags, setTags] = useState<string[] | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [download, setDownload] = useState<{
    busy: boolean;
    bytes: number;
    error: string | null;
    cancelled: boolean;
  }>({ busy: false, bytes: 0, error: null, cancelled: false });
  const downloadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setVisibility(null);
    setTags(null);
    setTagDraft("");
    setSaveError(null);
  }, [id, load.data?.updated_at]);

  const file = load.data;
  if (!file) {
    return (
      <main className="admin-main">
        <div className="page-header">
          <div>
            <p className="breadcrumb">
              <Link href="/admin/files">files</Link> /
            </p>
            <h1 className="page-title">Inspector</h1>
          </div>
        </div>
        <LoadFallback
          status={load.status === "ready" ? "loading" : load.status}
          message={load.message}
          onRetry={load.reload}
        />
      </main>
    );
  }

  const effectiveVisibility = visibility ?? file.visibility;
  const effectiveTags = tags ?? file.tags;
  const dirty =
    effectiveVisibility !== file.visibility ||
    JSON.stringify(effectiveTags) !== JSON.stringify(file.tags);

  async function saveChanges() {
    setSaving(true);
    setSaveError(null);
    try {
      await adminApi.updateFile(id, {
        ...(effectiveVisibility !== file!.visibility
          ? { visibility: effectiveVisibility }
          : {}),
        ...(JSON.stringify(effectiveTags) !== JSON.stringify(file!.tags)
          ? { tags: { operation: "set", values: effectiveTags } }
          : {}),
      });
      load.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function startDownload() {
    if (!file || download.busy) return;
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    setDownload({ busy: true, bytes: 0, error: null, cancelled: false });
    try {
      // Streams straight to disk where the File System Access API exists;
      // otherwise a bounded buffered fallback that refuses oversized objects
      // before any bytes are fetched.
      const outcome = await downloadFile(
        { id: file.id, name: file.name, size: file.size },
        browserDownloadEnvironment(adminApi),
        {
          signal: controller.signal,
          onProgress: (bytes) =>
            setDownload((current) => ({ ...current, bytes })),
        },
      );
      // Ordinary cancellation (picker dismissal, Cancel during response
      // establishment/stream/fallback) is a neutral outcome the operator is
      // told about — never a failure, never a silent reset.
      setDownload({
        busy: false,
        bytes: 0,
        error: null,
        cancelled: outcome.cancelled,
      });
    } catch (error) {
      // Cancellation is normalized to a resolved outcome by downloadFile;
      // this guard keeps an abort that slips through from rendering as a
      // failure.
      const cancelled = error instanceof Error && error.name === "AbortError";
      setDownload({
        busy: false,
        bytes: 0,
        error: cancelled
          ? null
          : error instanceof Error
            ? error.message
            : "Download failed",
        cancelled,
      });
    } finally {
      downloadAbortRef.current = null;
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await adminApi.deleteFile(id);
      router.push("/admin/files");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Delete failed");
      setDeleting(false);
      setConfirmOpen(false);
    }
  }

  return (
    <main className="admin-main">
      <div className="page-header">
        <div>
          <p className="breadcrumb">
            <Link href="/admin/files">files</Link> /
          </p>
          <h1 className="page-title mono">{file.name}</h1>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={download.busy}
            onClick={() => void startDownload()}
          >
            {download.busy
              ? file.size > 0
                ? `Downloading … ${formatBytes(download.bytes)} / ${formatBytes(file.size)}`
                : "Downloading …"
              : "Download"}
          </button>
          {download.busy ? (
            <button
              type="button"
              className="button"
              onClick={() => downloadAbortRef.current?.abort()}
            >
              Cancel download
            </button>
          ) : null}
          <button
            type="button"
            className="button"
            disabled={!dirty || saving}
            onClick={() => void saveChanges()}
          >
            {saving ? "Saving …" : "Save changes"}
          </button>
          <button
            type="button"
            className="button button-danger"
            onClick={() => setConfirmOpen(true)}
          >
            Delete
          </button>
        </div>
      </div>

      {saveError ? (
        <p className="state-banner state-api" role="alert">
          {saveError}
        </p>
      ) : null}
      {deleteError ? (
        <p className="state-banner state-api" role="alert">
          {deleteError}
        </p>
      ) : null}
      {download.error ? (
        <p className="state-banner state-api" role="alert">
          download failed — {download.error}
        </p>
      ) : null}
      {download.cancelled ? (
        <p className="state-banner" role="status">
          download cancelled
        </p>
      ) : null}

      <div className="inspector-split">
        <section className="preview-pane" aria-label="Preview">
          <div className="pane-head">
            <h2 className="section-label">Preview</h2>
            <span className="section-note">
              text ≤ 256 KB and images ≤ 4 MB render inline
            </span>
          </div>
          <div className="preview-body">
            <Preview file={file} />
          </div>
          <div>
            <div className="url-row">
              <span className="url-label">Preview</span>
              <span className="url-value">
                {file.preview_url}
                {file.visibility === "private"
                  ? " · auth: bearer header required"
                  : ""}
              </span>
              <CopyButton value={file.preview_url} label="Copy preview URL" />
            </div>
            <div className="url-row">
              <span className="url-label">Raw</span>
              <span className="url-value">
                {file.raw_url}
                {file.visibility === "private"
                  ? " · auth: bearer header required"
                  : ""}
              </span>
              <CopyButton value={file.raw_url} label="Copy raw URL" />
            </div>
            {file.visibility === "private" ? (
              <p className="url-note">
                both URLs need the Authorization: Bearer header — pasting them
                into a browser address bar cannot attach it, so unauthenticated
                requests receive 404 (by design)
              </p>
            ) : null}
          </div>
        </section>

        <section className="meta-pane" aria-label="Object record">
          <div className="pane-head">
            <h2 className="section-label">Object record</h2>
          </div>
          <dl>
            <div className="meta-row">
              <dt>id</dt>
              <dd>{file.id}</dd>
            </div>
            <div className="meta-row">
              <dt>size</dt>
              <dd>{formatExactBytes(file.size)}</dd>
            </div>
            <div className="meta-row">
              <dt>mime</dt>
              <dd>{file.mime_type}</dd>
            </div>
            <div className="meta-row">
              <dt>sha-256</dt>
              <dd>
                {file.sha256}
                <p className="meta-note text-success">
                  computed in stream during upload
                </p>
              </dd>
            </div>
            <div className="meta-row">
              <dt>uploaded</dt>
              <dd>{formatUtcDateTime(file.created_at)}</dd>
            </div>
            <div className="meta-row">
              <dt>meta updated</dt>
              <dd>{formatUtcDateTime(file.updated_at)}</dd>
            </div>
            <div className="meta-row">
              <dt>archive</dt>
              <dd>
                {file.archive === "tar.gz"
                  ? "tar.gz — uploaded as a directory archive"
                  : "none"}
                <p className="meta-note">
                  archive/hide toggle · Proposed · Not implemented
                </p>
              </dd>
            </div>
            <div className="meta-row">
              <dt>visibility</dt>
              <dd>
                <span className="meta-action">
                  <span>
                    <VisibilityLabel visibility={effectiveVisibility} />
                    {effectiveVisibility !== file.visibility
                      ? " · unsaved"
                      : ""}
                  </span>
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      setVisibility(
                        effectiveVisibility === "public" ? "private" : "public",
                      )
                    }
                  >
                    Make{" "}
                    {effectiveVisibility === "public" ? "private" : "public"}
                  </button>
                </span>
                <p className="meta-note">
                  {effectiveVisibility === "private"
                    ? "unauthenticated requests receive 404, not 403"
                    : "public — preview and raw URLs need no token"}
                </p>
              </dd>
            </div>
            <div className="meta-row">
              <dt>tags</dt>
              <dd>
                {effectiveTags.map((tagName) => (
                  <span className="tag-chip" key={tagName}>
                    {tagName}
                    <button
                      type="button"
                      aria-label={`Remove tag ${tagName}`}
                      onClick={() =>
                        setTags(
                          effectiveTags.filter((value) => value !== tagName),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                <span className="tag-add">
                  <input
                    type="text"
                    value={tagDraft}
                    aria-label="Add tag"
                    placeholder="+ add tag"
                    onChange={(event) => setTagDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      const value = tagDraft.trim();
                      if (!value) return;
                      if (!effectiveTags.includes(value))
                        setTags([...effectiveTags, value]);
                      setTagDraft("");
                    }}
                  />
                </span>
                {tags !== null &&
                JSON.stringify(effectiveTags) !== JSON.stringify(file.tags) ? (
                  <p className="meta-note">unsaved — press Save changes</p>
                ) : null}
              </dd>
            </div>
          </dl>
          <div className="danger-note">
            <span className="dot dot-danger" aria-hidden />
            <p>
              delete removes the object and its metadata row permanently · no
              soft-delete
            </p>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Delete object"
        body={`${file.name} · delete removes the object and its metadata row permanently · no soft-delete`}
        confirmLabel="Delete"
        busy={deleting}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void confirmDelete()}
      />
    </main>
  );
}
