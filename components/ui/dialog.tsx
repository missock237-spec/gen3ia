"use client";

import { useEffect, useRef } from "react";

import { cx } from "@/lib/ui/cx";

/**
 * Dialogue modal Gen3ia — overlay + focus initial + fermeture Échap.
 * Accessible : role="dialog", aria-modal, retour focus à l'ouverture.
 */
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function Dialog({ open, onClose, title, description, children, footer, className }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLElement>("button, [href], input, select, textarea")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      previousFocus?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center p-3 sm:items-center sm:p-6"
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          "anim-scale-in w-full max-w-lg overflow-hidden rounded-3xl border shadow-2xl",
          className,
        )}
        style={{ background: "var(--g3-surface)", borderColor: "var(--g3-border)" }}
      >
        <div className="px-6 pb-2 pt-5">
          <h2 className="text-base font-bold tracking-tight" style={{ color: "var(--g3-text)" }}>
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-sm leading-5" style={{ color: "var(--g3-muted)" }}>
              {description}
            </p>
          )}
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-6 py-4">{children}</div>
        {footer && (
          <div
            className="flex items-center justify-end gap-2 border-t px-6 py-3.5"
            style={{ borderColor: "var(--g3-border)" }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
