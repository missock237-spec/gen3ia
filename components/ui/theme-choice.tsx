"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Choix de thème explicite (Paramètres) — clair ou sombre, appliqué à TOUTE
 * l'application. Même clé de persistance que la bascule de la navigation
 * ("gen3ia-theme"), même attribut data-theme sur <html> (script anti-FOUC
 * du layout racine) : les deux contrôles restent synchronisés.
 */
const STORAGE_KEY = "gen3ia-theme";

/**
 * Contrat lot 108-b : le profil serveur (base R2) porte le thème choisi.
 * Après CHAQUE application d'un choix (sombre comme clair), on persiste en
 * FIRE-AND-FORGET : jamais bloquant, jamais d'erreur visible — le serveur
 * peut ne pas être provisionné (anonyme, hors-ligne, route absente).
 * localStorage reste la source de vérité instantanée (anti-FOUC layout).
 */
function persistThemeOnServer(next: ThemeChoiceValue): void {
  fetch("/api/auth/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ theme: next }),
    credentials: "same-origin",
  }).catch(() => undefined);
}

type ThemeChoiceValue = "dark" | "light";

const OPTIONS: Array<{ value: ThemeChoiceValue; label: string; description: string; icon: string }> = [
  { value: "dark", label: "Thème sombre", description: "Espace profond Aurora — identité Gen3ia.", icon: "🌙" },
  { value: "light", label: "Thème clair", description: "Porcelaine bleutée — toute l'app devient claire.", icon: "☀️" },
];

export function ThemeChoice() {
  const [theme, setTheme] = useState<ThemeChoiceValue>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
    setMounted(true);
  }, []);

  const apply = useCallback((next: ThemeChoiceValue) => {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* stockage indisponible : le thème reste appliqué pour la session */
    }
    // Persistance profil (fire-and-forget, voir persistThemeOnServer).
    persistThemeOnServer(next);
  }, []);

  return (
    <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Thème de l'application">
      {OPTIONS.map((option) => {
        const selected = mounted && theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`theme-choice-${option.value}`}
            onClick={() => apply(option.value)}
            className={`flex items-start gap-3 rounded-2xl p-4 text-left transition ${
              selected
                ? "bg-[var(--g3-primary-soft)] shadow-[0_12px_34px_-18px_rgba(124,92,255,0.55)]"
                : "bg-[var(--g3-elevated)] hover:bg-[var(--g3-hover)]"
            }`}
          >
            <span aria-hidden="true" className="text-xl">{option.icon}</span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-[var(--g3-text)]">{option.label}</span>
              <span className="mt-0.5 block text-xs leading-5 text-[var(--g3-muted)]">{option.description}</span>
            </span>
            <span
              aria-hidden="true"
              className={`ml-auto mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${
                selected ? "border-[var(--g3-primary)] bg-[var(--g3-primary)]" : "border-[var(--g3-border-strong)]"
              }`}
            >
              {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
