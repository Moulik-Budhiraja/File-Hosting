"use client";

import { useEffect, useId, useRef } from "react";

interface DialogProps {
  title: string;
  titleAdornment?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  tone?: "default" | "danger";
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  title,
  titleAdornment,
  onClose,
  children,
  footer,
  tone = "default",
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }
    return () => {
      previous?.focus?.();
    };
  }, []);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Escape must work even when focus has left the panel (e.g. after a
  // mouse click landed on the overlay). Events that originate inside the
  // panel are handled by the panel's own handler, so skip them here —
  // React delegates at the document, so stopPropagation alone cannot
  // prevent a double fire.
  useEffect(() => {
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const panel = panelRef.current;
      if (panel && event.target instanceof Node && panel.contains(event.target))
        return;
      onCloseRef.current();
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, []);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dialog-overlay">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`dialog-panel${tone === "danger" ? " dialog-danger" : ""}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="dialog-header">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          {titleAdornment ?? (
            <span className="dialog-hint" aria-hidden="true">
              esc closes
            </span>
          )}
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <footer className="dialog-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
