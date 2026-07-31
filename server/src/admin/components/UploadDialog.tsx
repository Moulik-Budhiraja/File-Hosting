"use client";

import { useId, useRef, useState } from "react";

import { adminApi } from "../client";
import { Modal } from "./Modal";

interface UploadDialogProps {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
}

export function UploadDialog({ open, onClose, onUploaded }: UploadDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [isArchive, setIsArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a file to upload");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminApi.uploadFile(file, {
        name: name.trim() || file.name,
        tags: tags
          .split(/[\s,]+/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        visibility: isPrivate ? "private" : "public",
        ...(isArchive ? { archive: "tar.gz" as const } : {}),
      });
      onUploaded();
      onClose();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : "Upload failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      labelledBy={titleId}
      describedBy={descriptionId}
      busy={busy}
      onClose={onClose}
    >
      <h2 id={titleId}>Upload object</h2>
      <p id={descriptionId}>
        streams to the server with the bearer header · sha-256 computed during
        upload
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          File
          <input ref={fileRef} type="file" required />
        </label>
        <label>
          Name (defaults to the file name)
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="report.pdf"
          />
        </label>
        <label>
          Tags (space separated)
          <input
            type="text"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="ingest batch"
          />
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(event) => setIsPrivate(event.target.checked)}
          />
          private — requires the bearer token to read
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={isArchive}
            onChange={(event) => setIsArchive(event.target.checked)}
          />
          mark as tar.gz directory archive (sets archive metadata)
        </label>
        {error ? (
          <p className="text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={busy}
          >
            {busy ? "Uploading …" : "Upload"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
