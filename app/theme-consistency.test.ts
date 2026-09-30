import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Étape 4 du plan 20 — cohérence stricte du thème : « thème sombre → TOUTE
 * l'interface sombre ; thème clair → tout clair, sans exception ». Ces tests
 * verrouillent les garde-fous structurels du système de thème.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("Couche de compatibilité bithème (globals.css)", () => {
  const css = read("app/globals.css");

  it("le thème SOMBRE remappe les pastels clairs codés en dur vers les tokens", () => {
    for (const rule of [
      '[data-theme="dark"] :where(.bg-emerald-50',
      '[data-theme="dark"] :where(.bg-amber-50',
      '[data-theme="dark"] :where(.bg-red-50',
      '[data-theme="dark"] :where(.bg-sky-50',
      '[data-theme="dark"] :where(.bg-violet-50',
      "var(--g3-success-soft)",
      "var(--g3-warning-soft)",
      "var(--g3-danger-soft)",
      "var(--g3-primary-soft)",
      "var(--g3-magenta-soft)",
    ]) {
      expect(css).toContain(rule);
    }
  });

  it("le thème CLAIR convertit hover:text-white et exempte les dégradés de marque --g3-gradient", () => {
    expect(css).toContain(".hover\\:text-white:hover");
    expect(css).toContain('[class*="--g3-gradient"]');
    // Exemption morte supprimée (la classe n'existe nulle part).
    expect(css).not.toContain("g3-primary-surface");
  });

  it("les deux blocs data-theme définissent les tokens soft/strong (aucun manqué)", () => {
    for (const token of [
      "--g3-success-soft",
      "--g3-success-strong",
      "--g3-warning-soft",
      "--g3-warning-strong",
      "--g3-danger-soft",
      "--g3-danger-strong",
      "--g3-primary-soft",
      "--g3-primary-strong",
      "--g3-magenta-soft",
    ]) {
      const occurrences = css.split(token).length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("Composants critiques — plus de pastels cassant le thème", () => {
  it("status-badge (déployé sur ~40 pages) n'utilise plus aucun pastel en dur", () => {
    const source = read("components/shells/status-badge.tsx");
    expect(source).not.toMatch(/bg-(emerald|sky|amber|red|indigo|green|rose)-\d{2,3}/);
    expect(source).toContain("--g3-success-soft");
    expect(source).toContain("--g3-danger-strong");
  });

  it("la vitrine expose la bascule de thème (toutes les surfaces, sans exception)", () => {
    const header = read("components/home/vitrine-header.tsx");
    expect(header).toContain("ThemeToggle");
  });

  it("l'écran d'erreur globale applique le thème choisi (bootstrap data-theme + variables)", () => {
    const page = read("app/global-error.tsx");
    expect(page).toContain('localStorage.getItem("gen3ia-theme")');
    expect(page).toContain("data-theme");
    expect(page).toContain("var(--g3-");
  });

  it("le meta theme-color suit le choix utilisateur (et non le seul système)", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toContain('m.setAttribute("content"');
    expect(layout).toContain('t==="light"');
  });
});
