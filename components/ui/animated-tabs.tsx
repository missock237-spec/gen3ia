"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface AnimatedTabItem {
  key: string;
  label: string;
  badge?: string;
}

/**
 * Onglets a pilule animee : la pilule glisse et se redimensionne vers
 * l'onglet actif (mesure DOM). Accessible (role tablist) et responsive :
 * sur mobile la barre devient scrollable horizontalement.
 */
export function AnimatedTabs({
  tabs,
  active,
  onChange,
  ariaLabel = "Sections",
}: {
  tabs: AnimatedTabItem[];
  active: string;
  onChange: (key: string) => void;
  ariaLabel?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  const measure = () => {
    const el = tabRefs.current.get(active);
    if (!el) return;
    setPill({ left: el.offsetLeft, width: el.offsetWidth });
  };

  useLayoutEffect(measure, [active, tabs.length]);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    // Re-mesure apres chargement des polices (evite un pilule mal calee).
    if (typeof document !== "undefined" && "fonts" in document) {
      (document as Document & { fonts?: FontFaceSet }).fonts?.ready.then(() => measure()).catch(() => undefined);
    }
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tabs.length]);

  return (
    <div ref={containerRef} role="tablist" aria-label={ariaLabel} className="g3-tabs max-w-full overflow-x-auto">
      {pill && <span className="g3-tab-pill" style={{ left: pill.left, width: pill.width }} aria-hidden="true" />}
      {tabs.map((tab) => (
        <button
          key={tab.key}
          ref={(el) => {
            if (el) tabRefs.current.set(tab.key, el);
            else tabRefs.current.delete(tab.key);
          }}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          data-active={active === tab.key}
          className="g3-tab"
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.badge && (
            <span className="rounded-md border border-[var(--g3-warning-soft)] bg-[var(--g3-warning-soft)] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--g3-warning-strong)]">
              {tab.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function AnimatedTabsSection({ children }: { children: ReactNode }) {
  return (
    <div role="tabpanel" className="anim-fade-in">
      {children}
    </div>
  );
}
