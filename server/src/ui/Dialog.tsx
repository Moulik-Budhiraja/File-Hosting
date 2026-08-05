"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface DialogProps {
  title: string;
  titleAdornment?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  tone?: "default" | "danger";
  /** While true a committed mutation is in flight: Escape and overlay
   * dismissal are blocked so progress/error/outcome stays visible. Cancel
   * buttons inside the dialog must also be disabled by the caller. */
  busy?: boolean;
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
  busy = false,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Coordinate modality and focus in one lifecycle so teardown always makes
  // the invoking subtree interactive before restoring focus. Only attributes
  // this instance set are removed, so nested dialogs unwind correctly.
  useEffect(() => {
    if (!mounted) return;
    const previous = document.activeElement as HTMLElement | null;
    const overlay = overlayRef.current;
    const touched: Element[] = [];
    for (const element of Array.from(document.body.children)) {
      if (element === overlay) continue;
      if (element.tagName === "SCRIPT" || element.tagName === "STYLE") continue;
      if (element.hasAttribute("inert")) continue;
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
      touched.push(element);
    }
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }
    return () => {
      for (const element of touched) {
        element.removeAttribute("inert");
        element.removeAttribute("aria-hidden");
      }
      previous?.focus?.();
    };
  }, [mounted]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Escape must work even when focus has left the panel (e.g. after a
  // mouse click landed on the overlay). Events that originate inside the
  // panel are handled by the panel's own handler, so skip them here —
  // React delegates at the document, so stopPropagation alone cannot
  // prevent a double fire.
  useEffect(() => {
    if (!mounted) return;
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (busyRef.current) return;
      const panel = panelRef.current;
      if (panel && event.target instanceof Node && panel.contains(event.target))
        return;
      onCloseRef.current();
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [mounted]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!busy) onClose();
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

  if (!mounted) return null;

  return createPortal(
    <div className="dialog-overlay" ref={overlayRef}>
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
          {titleAdornment ??
            (busy ? (
              <span className="dialog-hint" aria-hidden="true">
                working…
              </span>
            ) : null)}
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <footer className="dialog-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
