import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BANC DE RENDEMENT DU CACHE (Task 9-a) — preuve mesurée, pas promesse.
 *
 * Protocole : un calculateur volontairement coûteux (attente réelle de 2 ms
 * par calcul) est appelé N fois :
 *   - sans cache : chaque appel paie le calcul complet ;
 *   - avec cache : 1 miss puis N-1 hits (relectures mémoire, ~µs).
 * Le gain mesuré (temps moyen par appel sans cache ÷ avec cache) doit
 * dépasser 5×. Avec un calcul de 2 ms, le gain attendu est >> 10× : l'assertion
 * reste volontairement prudente pour rester stable sur les CI partagées.
 *
 * Ce banc mesure le MÉCANISME (élimination du recalcul), pas le débit HTTP
 * de bout en bout — l'ordre de grandeur du débit complet est traité dans
 * docs/perf-capacite.md (étage par étage, avec ses limites).
 */

import { cacheReponses, creerCacheReponses, reinitialiserCacheReponsesPourTests } from "./cache-reponses";

const N_APPELS = 40;
const COUT_CALCUL_MS = 2;

async function calculateurCouteux(): Promise<{ valeur: number }> {
  await new Promise((resolve) => setTimeout(resolve, COUT_CALCUL_MS));
  return { valeur: 42 };
}

beforeAll(() => {
  reinitialiserCacheReponsesPourTests();
});

afterAll(() => {
  reinitialiserCacheReponsesPourTests();
});

describe("rendement du cache (banc mesuré)", () => {
  it("le hit cache est plus de 5× plus rapide que le recalcul (N=40)", async () => {
    // Sans cache : chaque appel paie les 2 ms de calcul.
    const debutSansCache = performance.now();
    for (let i = 0; i < N_APPELS; i += 1) {
      await calculateurCouteux();
    }
    const tempsSansCache = performance.now() - debutSansCache;

    // Avec cache : 1 miss (payé une fois), puis N-1 hits mémoire.
    const cache = creerCacheReponses({ namespace: "banc-rendement" });
    await cache.obtenirOuCalculer("banc", 10_000, calculateurCouteux); // réchauffe
    const debutAvecCache = performance.now();
    for (let i = 1; i < N_APPELS; i += 1) {
      await cache.obtenirOuCalculer("banc", 10_000, calculateurCouteux);
    }
    const tempsAvecCache = performance.now() - debutAvecCache;

    // Sanity : sans cache, chaque appel a bien coûté ≥ 2 ms (attente réelle).
    expect(tempsSansCache).toBeGreaterThanOrEqual(N_APPELS * COUT_CALCUL_MS);
    const gain = tempsSansCache / Math.max(tempsAvecCache, 0.001);
    expect(gain).toBeGreaterThan(5);

    // Traçabilité du banc dans la sortie vitest (pas de prétention : mesure).
    console.info(
      `[banc cache] sans cache: ${tempsSansCache.toFixed(1)} ms · avec cache: ` +
        `${tempsAvecCache.toFixed(1)} ms · gain ×${gain.toFixed(1)}`,
    );
  });

  it("le single-flight absorbe une rafale : 50 appels simultanés ≈ le coût d'UN calcul", async () => {
    const cache = creerCacheReponses({ namespace: "banc-rafales" });
    let calculs = 0;
    const calculateur = async () => {
      calculs += 1;
      await new Promise((resolve) => setTimeout(resolve, COUT_CALCUL_MS));
      return { valeur: calculs };
    };

    const debut = performance.now();
    const resultats = await Promise.all(
      Array.from({ length: 50 }, () => cache.obtenirOuCalculer("rafales", 10_000, calculateur)),
    );
    const tempsRafale = performance.now() - debut;

    // Sans coalescing, 50 calculs concurrents planifieraient ~100 ms de
    // travail ; ici le mur de calcul est celui d'UN seul calcul.
    expect(calculs).toBe(1);
    expect(tempsRafale).toBeLessThan(50 * COUT_CALCUL_MS);
    for (const resultat of resultats) {
      expect(resultat).toEqual({ valeur: 1 });
    }
    expect(cache.stats()).toMatchObject({ misses: 1, coalesced: 49 });
  });

  it("le singleton partagé de l'application rend les mêmes stats que l'usage réel", async () => {
    await cacheReponses.obtenirOuCalculer("banc:singleton", 10_000, calculateurCouteux);
    const stats = cacheReponses.stats();
    expect(stats.misses).toBeGreaterThanOrEqual(1);
    expect(stats.taille).toBeGreaterThanOrEqual(1);
  });
});
