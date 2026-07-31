"use client";

import { useEffect, useRef } from "react";

interface ModalProps {
  open: boolean;
  role?: "dialog" | "alertdialog";
  labelledBy: string;
  describedBy: string;
  // While busy, Escape and backdrop clicks must not cancel the operation.
  busy?: boolean;
  onClose: () => void;
  // Focused after the dialog opens; falls back to the first focusable control.
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}

// Shared modal on the native <dialog> element: showModal() provides top-layer
// rendering, a full focus trap, inert background semantics, Escape handling
// (the cancel event), and focus restoration to the invoker on close.
export function Modal({
  open,
  role = "dialog",
  labelledBy,
  describedBy,
  busy = false,
  onClose,
  initialFocusRef,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    // React can unmount the <dialog> before the browser's native close-time
    // focus restoration runs, so the invoker is captured and restored
    // explicitly.
    const invoker =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.showModal();
    const target =
      initialFocusRef?.current ??
      dialog.querySelector<HTMLElement>(
        "input, select, textarea, button, [href], [tabindex]",
      );
    target?.focus();
    const onCancel = (event: Event) => {
      // Escape while an async operation runs must not dismiss the dialog.
      event.preventDefault();
      if (!busyRef.current) onCloseRef.current();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      invoker?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  function onKeyDown(event: React.KeyboardEvent) {
    // Native dialogs inert the background but still let Tab wander to the
    // browser chrome; wrap focus across the dialog's own controls instead.
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => !element.hasAttribute("disabled"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      role={role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="dialog"
      onKeyDown={onKeyDown}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (event.target === dialogRef.current && !busy) onClose();
      }}
    >
      {/* Clicks inside the content land here, not on the dialog/backdrop. */}
      <div className="dialog-inner">{children}</div>
    </dialog>
  );
}
