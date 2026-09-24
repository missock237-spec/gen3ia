"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Bascule de thème Gen3ia — sombre (identité plateforme) ↔ clair.
 * Persisté dans localStorage ("gen3ia-theme") ; appliqué via l'attribut
 * data-theme sur <html> posé par le script anti-FOUC du layout racine.
 */
const STORAGE_KEY = "gen3ia-theme";

export type ThemeChoice = "dark" | "light";

function readCurrentTheme(): ThemeChoice {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<ThemeChoice>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(readCurrentTheme());
    setMounted(true);
  }, []);

  const toggle = useCallback(() => {
    const next: ThemeChoice = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* stockage indisponible : le thème reste appliqué pour la session */
    }
  }, [theme]);

  const label = theme === "dark" ? "Passer en thème clair" : "Passer en thème sombre";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      data-testid="theme-toggle"
      className={`inline-flex items-center justify-center gap-2 rounded-xl border transition-colors ${
        compact ? "h-9 w-9" : "h-9 w-full px-3 sm:w-9"
      }`}
      style={{
        borderColor: "var(--g3-border)",
        background: "var(--g3-elevated)",
        color: "var(--g3-text-secondary)",
      }}
    >
      {mounted && theme === "light" ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      )}
      {!compact && <span className="text-xs font-semibold sm:hidden">Thème</span>}
    </button>
  );
}
