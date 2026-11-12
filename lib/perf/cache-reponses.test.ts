import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cache de réponses (Task 9-a) : LRU + TTL + single-flight (coalescing).
 * Chaque scénario utilise une instance ISOLÉE via creerCacheReponses —
 * le singleton partagé de l'application n'est pas pollué par les tests.
 */

import {
  cacheReponses,
  cleCache,
  creerCacheReponses,
  reinitialiserCacheReponsesPourTests,
} from "./cache-reponses";

function attendre(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("cleCache — clés namespacées", () => {
  it("compose namespace + version + segments", () => {
    expect(cleCache("catalogue-formation", "v1")).toBe("catalogue-formation:v1");
    expect(cleCache("stats-publiques-neural", "v1", "variante:a")).toBe(
      "stats-publiques-neural:v1:variante:a",
    );
  });

  it("refuse un namespace invalide (fail-fast en développement)", () => {
    expect(() => cleCache("")).toThrow(TypeError);
    expect(() => cleCache("Avec_Majuscules")).toThrow(TypeError);
    expect(() => cleCache("avec espace")).toThrow(TypeError);
    expect(() => cleCache("a".repeat(65))).toThrow(TypeError);
  });

  it("accepte les segments d'origine variée (nombre, booléen)", () => {
    expect(cleCache("grille", "v1", 42, true)).toBe("grille:v1:42:true");
  });
});

describe("hits / misses / TTL", () => {
  it("calcule au premier appel (miss) puis sert depuis le cache (hit)", async () => {
    const cache = creerCacheReponses({ namespace: "test-base" });
    let calculs = 0;
    const valeur = await cache.obtenirOuCalculer("cle:1", 5_000, async () => {
      calculs += 1;
      return { somme: 42 };
    });

    expect(valeur).toEqual({ somme: 42 });
    expect(calculs).toBe(1);

    const encore = await cache.obtenirOuCalculer("cle:1", 5_000, async () => {
      calculs += 1;
      return { somme: 999 };
    });

    // Même valeur que le calcul initial, calculateur non rappelé.
    expect(encore).toEqual({ somme: 42 });
    expect(calculs).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, tauxReussite: 0.5 });
  });

  it("expire après le TTL : hit avant, re-calcul après", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const cache = creerCacheReponses({ namespace: "test-ttl" });
      let calculs = 0;
      const calculateur = async () => {
        calculs += 1;
        return `generation-${calculs}`;
      };

      await expect(cache.obtenirOuCalculer("cle:ttl", 1_000, calculateur)).resolves.toBe(
        "generation-1",
      );
      vi.advanceTimersByTime(999);
      await expect(cache.obtenirOuCalculer("cle:ttl", 1_000, calculateur)).resolves.toBe(
        "generation-1",
      ); // encore frais : hit
      vi.advanceTimersByTime(1);
      await expect(cache.obtenirOuCalculer("cle:ttl", 1_000, calculateur)).resolves.toBe(
        "generation-2",
      ); // périmé : re-calcul
      expect(calculs).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("compte la latence gagnée (estimation) à chaque hit", async () => {
    const cache = creerCacheReponses({ namespace: "test-latence" });
    await cache.obtenirOuCalculer("cle:lente", 5_000, async () => {
      await attendre(10);
      return "ok";
    });
    await cache.obtenirOuCalculer("cle:lente", 5_000, async () => "rapide");

    const stats = cache.stats();
    // Le hit évite le re-paiement du calcul initial (~10 ms mesurés).
    expect(stats.latenceGagneeMs).toBeGreaterThan(5);
    expect(stats.hits).toBe(1);
  });

  it("propage l'erreur du calculateur, ne met rien en cache, retente ensuite", async () => {
    const cache = creerCacheReponses({ namespace: "test-erreur" });
    let calculs = 0;
    const calculateur = async () => {
      calculs += 1;
      if (calculs === 1) throw new Error("panne amont");
      return "recupere";
    };

    await expect(cache.obtenirOuCalculer("cle:err", 5_000, calculateur)).rejects.toThrow(
      "panne amont",
    );
    // Rien n'est stocké : l'appel suivant recalcule.
    await expect(cache.obtenirOuCalculer("cle:err", 5_000, calculateur)).resolves.toBe(
      "recupere",
    );
    expect(cache.stats()).toMatchObject({ erreurs: 1, misses: 2, taille: 1 });
  });

  it("refuse une clé vide ou un ttlMs invalide (TypeError)", async () => {
    const cache = creerCacheReponses({ namespace: "test-garde" });
    await expect(cache.obtenirOuCalculer("", 1_000, async () => 1)).rejects.toThrow(TypeError);
    await expect(cache.obtenirOuCalculer("cle", 0, async () => 1)).rejects.toThrow(TypeError);
    await expect(cache.obtenirOuCalculer("cle", -5, async () => 1)).rejects.toThrow(TypeError);
    await expect(cache.obtenirOuCalculer("cle", Number.NaN, async () => 1)).rejects.toThrow(
      TypeError,
    );
  });
});

describe("single-flight (coalescing)", () => {
  it("N=50 appels simultanés sur la même clé → 1 seul calcul, 49 coalescés", async () => {
    const cache = creerCacheReponses({ namespace: "test-flight" });
    let calculs = 0;
    const calculateur = async () => {
      calculs += 1;
      await attendre(20);
      return { appel: calculs };
    };

    const resultats = await Promise.all(
      Array.from({ length: 50 }, () => cache.obtenirOuCalculer("cle:rafales", 5_000, calculateur)),
    );

    // Un seul calcul déclenché, tous les appelants partagent la valeur.
    expect(calculs).toBe(1);
    expect(resultats).toHaveLength(50);
    for (const resultat of resultats) {
      expect(resultat).toEqual({ appel: 1 });
    }
    expect(cache.stats()).toMatchObject({ misses: 1, coalesced: 49 });
  });

  it("les clés différentes calculent en parallèle (pas de coalescing croisé)", async () => {
    const cache = creerCacheReponses({ namespace: "test-flight-cles" });
    const cles = ["cle:a", "cle:b", "cle:c"];
    let calculs = 0;
    const resultats = await Promise.all(
      cles.map((cle) =>
        cache.obtenirOuCalculer(cle, 5_000, async () => {
          calculs += 1;
          await attendre(10);
          return cle;
        }),
      ),
    );
    expect(calculs).toBe(3);
    expect(resultats).toEqual(cles);
    expect(cache.stats()).toMatchObject({ misses: 3, coalesced: 0 });
  });

  it("une erreur en vol est partagée par tous les coalescés, puis le vol est purgé", async () => {
    const cache = creerCacheReponses({ namespace: "test-flight-erreur" });
    let calculs = 0;
    const calculateur = async () => {
      calculs += 1;
      await attendre(10);
      throw new Error(`echec-${calculs}`);
    };

    const tentatives = await Promise.allSettled(
      Array.from({ length: 5 }, () => cache.obtenirOuCalculer("cle:err-vol", 5_000, calculateur)),
    );
    expect(calculs).toBe(1);
    for (const tentative of tentatives) {
      expect(tentative.status).toBe("rejected");
    }

    // Le vol échoué est purgé : l'appel suivant démarre un NOUVEAU calcul.
    await expect(cache.obtenirOuCalculer("cle:err-vol", 5_000, calculateur)).rejects.toThrow(
      "echec-2",
    );
    expect(calculs).toBe(2);
  });
});

describe("LRU — éviction bornée", () => {
  it("évince l'entrée la plus ancienne au-delà du plafond d'entrées", async () => {
    const cache = creerCacheReponses({ namespace: "test-lru", entreesMax: 2 });
    let calculsA = 0;
    let calculsB = 0;
    let calculsC = 0;
    const calcA = async () => {
      calculsA += 1;
      return "A";
    };
    const calcB = async () => {
      calculsB += 1;
      return "B";
    };
    const calcC = async () => {
      calculsC += 1;
      return "C";
    };

    await cache.obtenirOuCalculer("cle:a", 10_000, calcA);
    await cache.obtenirOuCalculer("cle:b", 10_000, calcB);
    // Lecture de A : sa récence passe devant B.
    await cache.obtenirOuCalculer("cle:a", 10_000, calcA);
    await cache.obtenirOuCalculer("cle:c", 10_000, calcC); // éviction de B

    expect(cache.stats().taille).toBe(2);
    expect(calculsB).toBe(1);
    // B a été évincée → re-calcul ; sa réinsertion évine à son tour l'entrée
    // la plus ancienne de la Map (A, dont la récence datait d'avant C).
    await expect(cache.obtenirOuCalculer("cle:b", 10_000, calcB)).resolves.toBe("B");
    expect(calculsB).toBe(2);
    // C est restée en cache pendant toute la séquence (jamais évincée).
    await expect(cache.obtenirOuCalculer("cle:c", 10_000, calcC)).resolves.toBe("C");
    expect(calculsC).toBe(1);
    // A, évincée par la réinsertion de B, est recalculée (comportement LRU
    // exact : la Map n'a jamais plus de 2 entrées vivantes).
    await expect(cache.obtenirOuCalculer("cle:a", 10_000, calcA)).resolves.toBe("A");
    expect(calculsA).toBe(2);
    expect(cache.stats().taille).toBe(2);
  });

  it("respecte le budget mémoire : une valeur hors budget n'est jamais stockée", async () => {
    // Budget minimum appliqué par la fabrique : 1 024 octets — on utilise
    // 2 048 pour tester un refus réel (valeur >> budget).
    const cache = creerCacheReponses({ namespace: "test-budget", octetsMax: 2_048 });
    let calculs = 0;
    const calculateur = async () => {
      calculs += 1;
      return "x".repeat(5_000); // >> 2 048 octets de budget
    };

    await expect(cache.obtenirOuCalculer("cle:volumineuse", 5_000, calculateur)).resolves.toHaveLength(
      5_000,
    );
    expect(cache.stats().taille).toBe(0); // refus silencieux du stockage
    await cache.obtenirOuCalculer("cle:volumineuse", 5_000, calculateur);
    expect(calculs).toBe(2); // re-calcul complet (dégradation propre)
  });

  it("purge les entrées périmées lors de l'éviction avant d'évincer des chaudes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const cache = creerCacheReponses({ namespace: "test-lru-ttl", entreesMax: 2 });
      let calculs = 0;
      const calculateur = async () => {
        calculs += 1;
        return calculs;
      };

      await cache.obtenirOuCalculer("cle:1", 500, calculateur); // périmera vite
      await cache.obtenirOuCalculer("cle:2", 10_000, calculateur);
      vi.advanceTimersByTime(600); // cle:1 périmée, cle:2 fraîche
      await cache.obtenirOuCalculer("cle:3", 10_000, calculateur); // purge cle:1, garde cle:2

      expect(cache.stats().taille).toBe(2);
      await expect(cache.obtenirOuCalculer("cle:2", 10_000, calculateur)).resolves.toBe(2);
      expect(calculs).toBe(3); // cle:1, cle:2, cle:3 — cle:2 JAMAIS recalculée
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("instances isolées et invalidation", () => {
  it("deux instances de namespace différent ne partagent rien", async () => {
    const cacheA = creerCacheReponses({ namespace: "ns-a" });
    const cacheB = creerCacheReponses({ namespace: "ns-b" });
    let calculs = 0;
    const calculateur = async () => {
      calculs += 1;
      return `calc-${calculs}`;
    };

    await expect(cacheA.obtenirOuCalculer("cle", 5_000, calculateur)).resolves.toBe("calc-1");
    await expect(cacheB.obtenirOuCalculer("cle", 5_000, calculateur)).resolves.toBe("calc-2");
    expect(calculs).toBe(2);
  });

  it("invalider supprime l'entrée vivante (retour honnête de l'existence)", async () => {
    const cache = creerCacheReponses({ namespace: "test-invalidation" });
    let calculs = 0;
    const calculateur = async () => {
      calculs += 1;
      return calculs;
    };

    await cache.obtenirOuCalculer("cle", 5_000, calculateur);
    expect(cache.invalider("cle")).toBe(true);
    expect(cache.invalider("cle")).toBe(false); // déjà absente
    await expect(cache.obtenirOuCalculer("cle", 5_000, calculateur)).resolves.toBe(2);
    expect(calculs).toBe(2);
  });
});

describe("singleton partagé de l'application", () => {
  beforeEach(() => {
    reinitialiserCacheReponsesPourTests();
  });

  afterEach(() => {
    reinitialiserCacheReponsesPourTests();
  });

  it("expose la même instance entre les imports (globalThis) et compte les stats", async () => {
    await cacheReponses.obtenirOuCalculer(cleCache("test-singleton", "v1"), 5_000, async () => "a");
    await cacheReponses.obtenirOuCalculer(cleCache("test-singleton", "v1"), 5_000, async () => "b");
    const stats = cacheReponses.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });
});
