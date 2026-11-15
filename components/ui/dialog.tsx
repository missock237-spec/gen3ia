"use client";

import { useEffect, useId, useRef } from "react";

import { cx } from "@/lib/ui/cx";

/**
 * Dialogue modal Gen3ia — overlay + focus initial + fermeture Échap.
 * Accessible : role="dialog", aria-modal, titre relié via aria-labelledby,
 * description via aria-describedby, PIÈGE DE FOCUS (Tab cyclé dans le panneau,
 * WCAG 2.4.3) et retour du focus à l'élément déclencheur à la fermeture.
 */

/** Sélecteur des éléments focalisables du panneau (hors tabindex=-1 et désactivés). */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** Éléments réellement visibles (un élément caché ne doit pas capter le Tab). */
function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

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
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      // Piège de focus : Tab (et Maj+Tab) restent dans le panneau.
      if (event.key === "Tab" && panel) {
        const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
        if (focusables.length === 0) {
          event.preventDefault();
          panel.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const current = document.activeElement;
        const inside = current instanceof HTMLElement && panel.contains(current);
        if (event.shiftKey) {
          if (!inside || current === first) {
            event.preventDefault();
            last.focus();
          }
        } else if (!inside || current === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKey);
    // Focus initial : premier élément interactif VISIBLE, sinon le panneau
    // lui-même (tabIndex={-1}) pour que la lecture d'écran parte du dialogue.
    const initial = Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []).find(isVisible);
    (initial ?? panel)?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      // Restauration du focus sur l'élément déclencheur à la fermeture.
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
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cx(
          "anim-scale-in w-full max-w-lg overflow-hidden rounded-3xl border shadow-2xl outline-none",
          className,
        )}
        style={{ background: "var(--g3-surface)", borderColor: "var(--g3-border)" }}
      >
        <div className="px-6 pb-2 pt-5">
          <h2 id={titleId} className="text-base font-bold tracking-tight" style={{ color: "var(--g3-text)" }}>
            {title}
          </h2>
          {description && (
            <p id={descriptionId} className="mt-1 text-sm leading-5" style={{ color: "var(--g3-muted)" }}>
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
