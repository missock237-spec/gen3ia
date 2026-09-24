"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Drawer latéral accessible du Studio (utilisé par l'Atelier d'Interfaces).
 * Entreprise/WCAG :
 *  - fermeture au clavier (Échap) et au clic sur l'arrière-plan ;
 *  - verrouillage du scroll d'arrière-plan pendant l'ouverture ;
 *  - focus initial dans le panneau + restitution au fermoir d'origine ;
 *  - aria-modal + libellé arbitraire via aria-labelledby côté appelant.
 */
export function DetailDrawer({
  labelledBy,
  onClose,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    // Verrouille le scroll d'arrière-plan.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      // Piège à focus minimal : Tab reste dans le panneau.
      if (event.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);
    // Focus initial dans le panneau.
    const focusTimer = window.setTimeout(() => {
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      (focusables && focusables.length > 0 ? focusables[0] : panelRef.current)?.focus();
    }, 30);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[var(--g3-deep)]/45 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="g3-drawer anim-slide-in-right h-full w-full max-w-3xl overflow-y-auto border-l border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-5 shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)] outline-none md:p-7"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
