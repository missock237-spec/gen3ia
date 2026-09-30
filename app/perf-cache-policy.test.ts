import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Étape 19 — performance : politique de cache HTTP des assets statiques.
 *
 * Les icônes et l'image Open Graph sont des assets quasi-immuables (versionnés
 * par query ?v= ou remplacés au déploiement) : servis avec un cache long +
 * stale-while-revalidate, ils ne sont plus re-téléchargés à chaque visite —
 * LCP des pages publiques et revisites accélérés sans risque de périmé
 * durable. À l'inverse, le service worker et la page hors-ligne restent
 * revalidés à CHAQUE visite : un sw.js servi depuis un cache navigateur
 * ferait rater toutes les mises à jour PWA suivantes (le navigateur plafonne
 * sinon sa vérification à 24 h, étape 11).
 *
 * Garde-fou : le middleware ne doit JAMAIS poser de Cache-Control global —
 * deux en-têtes Cache-Control (middleware + next.config) produisent une
 * intersection imprévisible côté navigateur (même règle que la CSP).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("Politique de cache statique (next.config headers)", () => {
  const config = read("next.config.ts");

  it("icônes + image OG : cache long avec stale-while-revalidate", () => {
    expect(config).toContain('source: "/icons/:path*"');
    expect(config).toContain('source: "/og-image.png"');
    expect(config).toContain("public, max-age=86400, stale-while-revalidate=604800");
  });

  it("manifeste : frais 1 h puis revalidation périmée (méta d'installabilité suivie)", () => {
    expect(config).toContain('source: "/manifest.webmanifest"');
    expect(config).toContain("public, max-age=3600, stale-while-revalidate=86400");
  });

  it("sw.js et offline.html : JAMAIS servis depuis un cache navigateur (max-age=0, must-revalidate)", () => {
    expect(config).toContain('source: "/sw.js"');
    expect(config).toContain('source: "/offline.html"');
    expect(config).toContain("public, max-age=0, must-revalidate");
  });

  it("le middleware ne pose PAS de Cache-Control (deux en-têtes = intersection imprévisible)", () => {
    expect(read("middleware.ts")).not.toMatch(/cache-control/i);
  });
});
