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

describe("Micro-cache sonnette notifications (quota Firestore, Task 101)", () => {
  const route = read("app/api/notifications/route.ts");

  it("la forme canonique du polling passe par cacheWrap avec un TTL ≥ 35 s", () => {
    // Pourquoi ≥ 35 s : le centre de notifications sonne GET /api/notifications
    // toutes les 25 s par client ouvert. Un TTL plus court expirait ENTRE deux
    // polls (TTL 20 s historique = ~100 % de MISS, soit ~31 lectures Firestore
    // par tick pour une cloche). La fraîcheur ne repose PAS sur le TTL :
    // invalidateNotificationsCache() invalide la clé à chaque mutation
    // (création, marquage lu) — le TTL n'est qu'un filet anti-dérive.
    const correspondance = route.match(/cacheWrap\([^;]*?,\s*(\d+)\s*,\s*chargeur/);
    expect(correspondance).not.toBeNull();
    expect(Number(correspondance?.[1])).toBeGreaterThanOrEqual(35);
  });

  it("la fraîcheur repose sur l'invalidation événementielle (repository)", () => {
    // Garde structurel : si l'invalidation disparaît du repository, le TTL
    // devient la seule garantie de fraîcheur et la sonnette peut afficher un
    // compteur périmé jusqu'à 40 s.
    const repository = read("lib/notifications/repository.ts");
    expect(repository).toContain("invalidateNotificationsCache(");
    expect(repository).toContain("cacheDelete(notificationsCacheKey(");
  });
});
