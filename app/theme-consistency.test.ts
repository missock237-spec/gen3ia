import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Étape 4 du plan 20 — cohérence stricte du thème : « thème sombre → TOUTE
 * l'interface sombre ; thème clair → tout clair, sans exception ». Ces tests
 * verrouillent les garde-fous structurels du système de thème.
 *
 * Task 108-c — extension « SEULEMENT 2 THÈMES » :
 * · globals.css ne déclare EXACTEMENT que les blocs :root (sombre « Nebula »)
 *   et [data-theme="light"] (clair « Porcelaine bleutée ») — aucune troisième
 *   valeur data-theme nulle part dans la feuille ;
 * · parité COMPLÈTE des tokens --g3-* entre les deux blocs (aucun token
 *   sombre orphelin côté clair, ni l'inverse) ;
 * · zéro hex brut dans agent-chat-panel.tsx (tout passe par les tokens
 *   --g3-*, adaptés par thème) ;
 * · ThemeChoice persiste le choix serveur (PUT /api/auth/profile { theme },
 *   contrat lot 108-b) en fire-and-forget ;
 * · valeurs clés des deux palettes verrouillées (primaire #7C5CFF sombre /
 *   #6C48FF clair, fonds, hiérarchie de texte lisible).
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

describe("Artéfact « carré parasite » (étape 12 + exigence utilisateur)", () => {
  it("le textarea du composer n'a plus le contour rectangulaire violet au focus (le focus-within de la carte signale l'état)", () => {
    const composer = read("components/ui/command-composer.tsx");
    // La règle globale textarea:focus-visible { outline: 2px solid var(--g3-primary) }
    // battait .outline-none (spécificité) et dessinait un rectangle à angles
    // droits autour du composer — capture utilisateur IMG_20260929.
    expect(composer).toContain("focus-visible:outline-none focus-visible:ring-0");
  });

  it("TOUTES les interfaces de prompt utilisateur sont neutralisées (le carré ne doit plus apparaître nulle part)", () => {
    // Exigence utilisateur : le « carré » recouvrait encore les autres
    // interfaces de prompt. Chaque textarea de saisie IA porte désormais la
    // neutralisation explicite (spécificité > textarea:focus-visible global).
    const surfaces: Array<[string, RegExp]> = [
      ["components/workspace/mission-composer.tsx", /outline-none focus-visible:outline-none focus-visible:ring-0/],
      ["app/page.tsx", /outline-none focus-visible:outline-none focus-visible:ring-0/],
      ["app/client/[agentId]/page.tsx", /outline-none focus-visible:outline-none focus-visible:ring-0/],
      ["app/client/c/[slug]/page.tsx", /outline-none focus-visible:outline-none focus-visible:ring-0/],
      ["components/ui/chatgpt-prompt-input.tsx", /outline-none focus-visible:outline-none focus-visible:ring-0/],
    ];
    for (const [file, pattern] of surfaces) {
      expect(read(file), `textarea sans neutralisation : ${file}`).toMatch(pattern);
    }
  });

  it("la règle globale de focus reste en place pour l'accessibilité des autres éléments", () => {
    const css = read("app/globals.css");
    expect(css).toContain("textarea:focus-visible");
    expect(css).toContain("outline: 2px solid var(--g3-primary)");
  });
});

/* ============================================================
   Task 108-c — « SEULEMENT 2 THÈMES » + harmonisation agent IA.
   Utilitaires de parsing CSS simple (blocs sans accolades imbriquées :
   :root et [data-theme="light"] ne contiennent que des déclarations).
   ============================================================ */

/** Extrait le contenu du premier bloc correspondant au sélecteur. */
function blockOf(css: string, selector: RegExp): string {
  return selector.exec(css)?.[1] ?? "";
}

/** Map nom → valeur des déclarations --g3-* d'un bloc. */
function tokensOf(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of block.matchAll(/^\s*(--g3-[a-z0-9-]+)\s*:\s*([^;]+);/gm)) {
    map.set(match[1], match[2].trim());
  }
  return map;
}

describe("Deux thèmes et seulement deux (verrou 108-c)", () => {
  const css = read("app/globals.css");

  it("globals.css déclare exactement :root (sombre) + [data-theme=\"light\"] — aucune autre valeur data-theme", () => {
    // Toutes les valeurs d'attribut data-theme présentes dans la feuille :
    const values = new Set<string>();
    for (const match of css.matchAll(/data-theme\s*=\s*"([a-z0-9_-]+)"/g)) {
      values.add(match[1]);
    }
    expect([...values].sort()).toEqual(["dark", "light"]);
    // Les deux blocs de TOKENS existent (sombre = :root par défaut).
    expect(css).toMatch(/(?:^|\n):root\s*\{/);
    expect(css).toMatch(/\[data-theme="light"\]\s*\{/);
    // Aucun bloc de tokens dupliqué sous une autre valeur (ex. [data-theme="midnight"]).
    expect(css).not.toMatch(/data-theme\s*=\s*"(?!light|dark)[a-z0-9_-]+"/);
  });

  it("parité complète : chaque token --g3-* de :root existe dans [data-theme=\"light\"] (et inversement)", () => {
    const darkTokens = tokensOf(blockOf(css, /(?:^|\n):root\s*\{([^}]*)\}/));
    const lightTokens = tokensOf(blockOf(css, /\[data-theme="light"\]\s*\{([^}]*)\}/));
    expect(darkTokens.size).toBeGreaterThan(30);
    const missingInLight = [...darkTokens.keys()].filter((name) => !lightTokens.has(name));
    const missingInDark = [...lightTokens.keys()].filter((name) => !darkTokens.has(name));
    expect(missingInLight, "tokens sombres sans équivalent clair").toEqual([]);
    expect(missingInDark, "tokens clairs sans équivalent sombre").toEqual([]);
  });

  it("les nouvelles surfaces info/bordures soft sont définies dans les DEUX blocs", () => {
    for (const token of ["--g3-info", "--g3-info-soft", "--g3-info-border", "--g3-warning-border", "--g3-danger-border"]) {
      const occurrences = css.split(token).length - 1;
      expect(occurrences, `${token} doit exister dans :root ET [data-theme="light"]`).toBeGreaterThanOrEqual(2);
    }
  });

  it("valeurs clés des deux palettes (fonds, texte, primaires conservés)", () => {
    const darkTokens = tokensOf(blockOf(css, /(?:^|\n):root\s*\{([^}]*)\}/));
    const lightTokens = tokensOf(blockOf(css, /\[data-theme="light"\]\s*\{([^}]*)\}/));
    // Primaire signature conservé des deux côtés.
    expect(darkTokens.get("--g3-primary")).toBe("#7C5CFF");
    expect(lightTokens.get("--g3-primary")).toBe("#6C48FF");
    // Clair « Porcelaine bleutée » : fonds + hiérarchie de texte agent IA.
    expect(lightTokens.get("--g3-bg")).toBe("#EFF7FB");
    expect(lightTokens.get("--g3-text")).toBe("#101B26");
    expect(lightTokens.get("--g3-text-secondary")).toBe("#1F4E5F");
    expect(lightTokens.get("--g3-muted")).toBe("#3E6478");
    // Task 125 — identité 2 COULEURS, clair : cyan foncé / violet foncé.
    expect(lightTokens.get("--g3-secondary")).toBe("#0899B4");
    expect(lightTokens.get("--g3-info")).toBe("#0E5F73");
    expect(lightTokens.get("--g3-success")).toBe("#0A6E82");
    expect(lightTokens.get("--g3-magenta")).toBe("#5633E8");
    expect(lightTokens.get("--g3-warning")).toBe("#6C48FF");
    expect(lightTokens.get("--g3-warning-strong")).toBe("#3F22C4");
    expect(lightTokens.get("--g3-danger")).toBe("#5B2BE0");
    // Sombre « Nebula » : identité violette intacte + cyan lisible.
    expect(darkTokens.get("--g3-bg")).toBe("#05060C");
    expect(darkTokens.get("--g3-surface")).toBe("#0B0D17");
    expect(darkTokens.get("--g3-secondary")).toBe("#2AD4E8");
    expect(darkTokens.get("--g3-info")).toBe("#7FE9F5");
    expect(darkTokens.get("--g3-success")).toBe("#2AD4E8");
    expect(darkTokens.get("--g3-magenta")).toBe("#9E85FF");
    expect(darkTokens.get("--g3-warning")).toBe("#9E85FF");
    expect(darkTokens.get("--g3-danger")).toBe("#B18AFF");
  });

  it("Task 125 — les ANCIENNES teintes des 5 familles supprimées sont bannies des tokens", () => {
    // marron/ambre/rouge/vert/magenta historiques : la migration doit être
    // totale dans les DEUX blocs (magenta→violet, info/success→cyan,
    // warning/danger→violet).
    const css = read("app/globals.css");
    for (const banned of [
      "#C44BFF", "#E14FEA", "#C026D3", // fuchsia/magenta historique
      "#2FD48A", "#6FE8B2", "#16A34A", "#15803D", // vert historique
      "#F5AE31", "#FBC96B", "#B45309", "#6B5210", // ambre historique
      "#F6626E", "#FB8E96", "#B33636", "#9B2C2C", // rouge historique
      "#8FD8EC", // info canard historique (→ cyan #7FE9F5)
    ]) {
      expect(css, `ancienne teinte ${banned} encore présente`).not.toContain(banned);
    }
  });

  it("Task 125 — dégradés signature : 2 stops violet → cyan (aucun stop intermédiaire)", () => {
    const darkTokens = tokensOf(blockOf(css, /(?:^|\n):root\s*\{([^}]*)\}/));
    const lightTokens = tokensOf(blockOf(css, /\[data-theme="light"\]\s*\{([^}]*)\}/));
    expect(darkTokens.get("--g3-gradient")).toBe("linear-gradient(115deg, #7C5CFF, #2AD4E8)");
    expect(lightTokens.get("--g3-gradient")).toBe("linear-gradient(115deg, #6C48FF, #0899B4)");
    // Le stop fuchsia intermédiaire a disparu de tous les dégradés tokens.
    for (const token of ["--g3-gradient", "--g3-gradient-soft", "--g3-gradient-line"]) {
      expect(darkTokens.get(token)).not.toMatch(/45%/);
      expect(lightTokens.get(token)).not.toMatch(/45%/);
    }
  });
});


describe("Persistance serveur du thème (contrat lot 108-b)", () => {
  const choice = read("components/ui/theme-choice.tsx");

  it("ThemeChoice envoie PUT /api/auth/profile avec { theme } en fire-and-forget", () => {
    expect(choice).toContain('fetch("/api/auth/profile"');
    expect(choice).toContain('method: "PUT"');
    expect(choice).toContain("JSON.stringify({ theme: next })");
    expect(choice).toContain('credentials: "same-origin"');
    // Jamais bloquant, jamais d'erreur visible.
    expect(choice).toContain(".catch(() => undefined)");
  });

  it("aucun troisième choix : les contrôles ne proposent que « dark » | « light »", () => {
    expect(choice).toMatch(/"dark" \| "light"/);
    const toggle = read("components/ui/theme-toggle.tsx");
    expect(toggle).toMatch(/"dark" \| "light"/);
    for (const source of [choice, toggle]) {
      expect(source).not.toMatch(/"system"|"auto"|"high-contrast"|"sepia"/);
    }
  });
});
