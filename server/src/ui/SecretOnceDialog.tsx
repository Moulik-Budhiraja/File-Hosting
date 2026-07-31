"use client";

import { useState } from "react";

import { Dialog } from "./Dialog";

interface SecretOnceDialogProps {
  title: string;
  tag: string;
  intro: string;
  secret: string;
  acknowledgement: string;
  footnote?: string;
  onDone: () => void;
}

// Shows a freshly created secret exactly once. Dismissal requires the
// explicit acknowledgement, or a second Escape after a discard warning.
export function SecretOnceDialog({
  title,
  tag,
  intro,
  secret,
  acknowledgement,
  footnote,
  onDone,
}: SecretOnceDialogProps) {
  const [acked, setAcked] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [closeWarned, setCloseWarned] = useState(false);

  function close() {
    if (!acked && !closeWarned) {
      setCloseWarned(true);
      return;
    }
    onDone();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <Dialog
      title={title}
      titleAdornment={<span className="tag tag-success">{tag}</span>}
      onClose={close}
    >
      <p>{intro}</p>
      <div className="secret-block">
        <code className="secret-value">{secret}</code>
        <button
          type="button"
          className={`button${copied ? " button-confirmed" : ""}`}
          onClick={() => void copy()}
        >
          {copied ? "copied ✓" : "Copy"}
        </button>
      </div>
      {copyFailed ? (
        <p className="field-error" role="alert">
          Copy failed — select the value and copy it manually.
        </p>
      ) : null}
      <label className="check-row">
        <input
          type="checkbox"
          checked={acked}
          onChange={(event) => {
            setAcked(event.target.checked);
            setCloseWarned(false);
          }}
        />
        {acknowledgement}
      </label>
      {footnote ? <p className="form-footnote">{footnote}</p> : null}
      {closeWarned && !acked ? (
        <p className="field-error" role="alert">
          You haven&apos;t confirmed you stored this value. Tick the box and
          press Done, or press Esc again to discard it permanently.
        </p>
      ) : null}
      <div className="dialog-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!acked}
          onClick={onDone}
        >
          Done
        </button>
      </div>
    </Dialog>
  );
}
