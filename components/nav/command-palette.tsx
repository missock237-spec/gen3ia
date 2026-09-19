"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { NAV_COMMAND_INDEX } from "./nav-items";

type PaletteItem = {
  href: string;
  label: string;
  icon: string;
  group: string;
};

const normalized = (value: string) =>
  value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/**
 * Palette de navigation (⌘K) : recherche insensible aux accents sur
 * toutes les destinations de la plateforme, clavier complet
 * (↑ ↓ choisir, ↵ ouvrir, Esc fermer).
 */
export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
  }, [open]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Escape") {
        onClose();
      }
    };
    if (open) {
      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }
  }, [open, onClose]);

  const active = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  const filtered = useMemo(() => {
    const items: PaletteItem[] = NAV_COMMAND_INDEX;
    return items.filter((item) =>
      normalized(item.label).includes(normalized(query.trim())),
    );
  }, [query]);

  const goTo = (href: string) => {
    onClose();
    router.push(href);
  };

  if (!open) return null;

  return (
    <div className="g3-command-overlay" role="dialog" aria-modal="true" aria-label="Navigation Gen3ia">
      <button type="button" className="g3-command-backdrop" onClick={onClose} aria-label="Fermer" />
      <div className="g3-command-panel">
        <div className="g3-command-search">
          <span aria-hidden="true">⌕</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((value) => Math.min(value + 1, Math.max(filtered.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const target = filtered[cursor];
                if (target) goTo(target.href);
              }
            }}
            placeholder="Aller à…"
            aria-label="Rechercher une destination"
            role="combobox"
            aria-expanded="true"
            aria-controls="g3-command-listbox"
            aria-activedescendant={filtered[cursor] ? `g3-command-opt-${cursor}` : undefined}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="g3-command-list" id="g3-command-listbox" role="listbox">
          {filtered.length ? filtered.map((item, index) => (
            <button
              key={item.href}
              id={`g3-command-opt-${index}`}
              type="button"
              role="option"
              aria-selected={index === cursor}
              onMouseEnter={() => setCursor(index)}
              onClick={() => goTo(item.href)}
              className={`g3-command-item ${index === cursor ? "is-cursor" : ""}`}
            >
              <span className="g3-side-icon">{item.icon}</span>
              <span className="flex-1 text-left">{item.label}</span>
              <span className="g3-command-group">{item.group}</span>
              {active(item.href) && <span className="g3-command-current">Actuel</span>}
            </button>
          )) : (
            <div className="px-4 py-8 text-center text-xs text-neutral-400">Aucune destination trouvée.</div>
          )}
        </div>
        <div className="g3-command-footer">
          <span>Navigation rapide</span><span><kbd>↑ ↓</kbd> choisir</span><span><kbd>↵</kbd> ouvrir</span><span><kbd>Esc</kbd> fermer</span>
        </div>
      </div>
    </div>
  );
}
