import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Audit de production — §7 CI/CD et §4 Sécurité : pipeline de CI.
 *
 * Garde-fous structurels : le cache du build Next.js (.next/cache) doit
 * rester branché sur TOUS les jobs qui compilent (le build est l'étape la
 * plus lourde — plusieurs minutes à chaque run sans lui), et le SAST CodeQL
 * (flux de données : injections, XSS, chemins non vérifiés) doit rester
 * acté en plus du scan de secrets gitleaks. Toute suppression de l'un de
 * ces étages doit être une décision explicite, pas un oubli.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("Pipeline CI (.github/workflows/ci.yml)", () => {
  const ci = read(".github/workflows/ci.yml");

  it("cache npm conservé (setup-node) sur les jobs", () => {
    expect(ci).toContain("cache: npm");
  });

  it("cache .next/cache branché sur les DEUX jobs qui buildent (ci + a11y)", () => {
    // 2 jobs × (path + key) : le comptage protège contre la suppression
    // silencieuse de l'un des deux branchements.
    expect(ci.split("path: .next/cache").length - 1).toBe(2);
    expect(ci.split("key: nextjs-").length - 1).toBe(2);
    // restore-keys : réutilise le dernier cache connu même si le SHA diffère.
    expect(ci.match(/restore-keys: \|\n\s+nextjs-/g)?.length).toBe(2);
  });

  it("aucune régression : audit deps, typecheck, lint, tests avec seuils, budget bundle", () => {
    expect(ci).toContain("npm audit --omit=dev --audit-level=high");
    expect(ci).toContain("npm run typecheck");
    expect(ci).toContain("npm run lint");
    expect(ci).toContain("npm run test:coverage");
    expect(ci).toContain("npm run check:bundle");
  });

  it("scan de secrets gitleaks toujours présent (historique complet)", () => {
    expect(ci).toContain("gitleaks/gitleaks-action@v2");
    expect(ci).toContain("fetch-depth: 0");
  });
});

describe("SAST CodeQL (.github/workflows/codeql.yml)", () => {
  const codeql = read(".github/workflows/codeql.yml");

  it("déclencheurs : push + PR sur main + hebdomadaire (lundi 03:00 UTC)", () => {
    expect(codeql).toContain('branches: [main]');
    expect(codeql).toContain('cron: "0 3 * * 1"');
  });

  it("langage javascript-typescript avec la suite security-extended", () => {
    expect(codeql).toContain("languages: javascript-typescript");
    expect(codeql).toContain("queries: security-extended");
  });

  it("permissions minimales : security-events: write + contents: read (moindre privilège)", () => {
    expect(codeql).toContain("security-events: write");
    expect(codeql).toContain("contents: read");
  });

  it("actions CodeQL v3 : init → autobuild → analyze (catégorie verrouillée)", () => {
    expect(codeql).toContain("github/codeql-action/init@v3");
    expect(codeql).toContain("github/codeql-action/autobuild@v3");
    expect(codeql).toContain("github/codeql-action/analyze@v3");
    expect(codeql).toContain('category: "/language:javascript-typescript"');
  });
});
