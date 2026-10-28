import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Itération 19 Job 478451 — couverture a11y de la surface publique.
 *
 * La sonde axe-core (scripts/a11y_prod.mjs) est BLOQUANTE en CI sur toute
 * violation WCAG 2.1 AA critical/serious. Sa valeur de garde dépend de sa
 * couverture : si une page publique est ajoutée au sitemap sans être
 * scannée (ou inversement), l'écart doit casser CE test — pas passer
 * inaperçu en production.
 *
 * Garde-fous :
 *  1. parité sitemap ↔ sonde (les deux sens) ;
 *  2. pas de doublon dans l'une ou l'autre liste ;
 *  3. la sonde couvre les DEUX thèmes (sombre + clair) — l'itération 19 a
 *     prouvé qu'un thème peut violer pendant que l'autre passe.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

function sitemapPaths(): string[] {
  const source = read("app/sitemap.ts");
  const paths = [...source.matchAll(/url: `\$\{BASE\}(\/[a-z-]*)?`/g)].map((m) => m[1] ?? "/");
  return paths;
}

function probePages(): string[] {
  const source = read("scripts/a11y_prod.mjs");
  const block = source.match(/const PAGES = \[([\s\S]*?)\];/);
  expect(block, "scripts/a11y_prod.mjs doit déclarer const PAGES = [...]").not.toBeNull();
  return [...block![1].matchAll(/"(\/[a-z-]*)"/g)].map((m) => m[1] ?? "/");
}

describe("couverture a11y — sitemap ↔ sonde axe-core", () => {
  const sitemap = sitemapPaths();
  const probe = probePages();

  it("le sitemap déclare au moins les 11 surfaces publiques connues", () => {
    expect(sitemap.length).toBeGreaterThanOrEqual(11);
    expect(sitemap).toContain("/");
    expect(sitemap).toContain("/login");
  });

  it("parité exacte sitemap ↔ sonde (aucune page publique non scannée)", () => {
    expect(new Set(probe)).toEqual(new Set(sitemap));
  });

  it("aucun doublon dans le sitemap ni dans la sonde", () => {
    expect(new Set(sitemap).size).toBe(sitemap.length);
    expect(new Set(probe).size).toBe(probe.length);
  });

  it("la sonde balaie les deux thèmes (sombre + clair) — bloquant en CI", () => {
    const source = read("scripts/a11y_prod.mjs");
    expect(source).toContain("name: \"sombre\"");
    expect(source).toContain("name: \"clair\"");
    expect(source).toMatch(/localStorage:\s*"light"/);
  });

  it("la sonde échoue sur les impacts critical et serious", () => {
    const source = read("scripts/a11y_prod.mjs");
    expect(source).toMatch(/BLOCKING_IMPACTS\s*=\s*new Set\(\["critical",\s*"serious"\]\)/);
  });
});
