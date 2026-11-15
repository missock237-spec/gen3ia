import { mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AccumulateurDerive,
  CATEGORIE_AUTRES,
  SEUIL_PSI_STABLE,
  SEUIL_PSI_SURVEILLANCE,
  accumulateurDeriveGlobal,
  calculerScorePsi,
  statutPsi,
} from "./drift";

/**
 * DÉTECTION DE DÉRIVE — tests du score PSI (valeurs calculées à la main)
 * et de l'accumulateur de comptages par catégorie (snapshot, cap,
 * persistance atomique var/neural/stats/).
 *
 * Les tests de persistance écrivent dans un dossier temporaire dédié
 * (jamais var/).
 */

const temporaires: string[] = [];

function cheminStatsTest(): string {
  const dir = mkdtempSync(join(tmpdir(), "gen3-drift-"));
  temporaires.push(dir);
  return join(dir, "derive-comptages.json");
}

afterEach(() => {
  while (temporaires.length > 0) {
    const dir = temporaires.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("score PSI (lib/mlops/drift)", () => {
  it("distributions identiques → PSI = 0, statut stable", () => {
    const score = calculerScorePsi(
      { GENERER_IMAGE: 60, INTENTION_GENERALE: 40 },
      { GENERER_IMAGE: 60, INTENTION_GENERALE: 40 },
    );
    expect(score.psi).toBe(0);
    expect(score.statut).toBe("stable");
    expect(score.echantillonsReference).toBe(100);
    expect(score.echantillonsObserve).toBe(100);
  });

  it("valeur exacte connue : 50/50 → 75/25 = PSI ≈ 0,2747 (dérive)", () => {
    const score = calculerScorePsi(
      { a: 50, b: 50 },
      { a: 75, b: 25 },
    );
    // (0,5−0,75)·ln(0,5/0,75) + (0,5−0,25)·ln(0,5/0,25) = 0,10137 + 0,17329.
    expect(score.psi).toBeCloseTo(0.2746530722, 6);
    expect(score.statut).toBe("derive");
    // Chaque contribution est ≥ 0 et la somme fait le PSI.
    expect(score.parCategorie.every((c) => c.psi >= 0)).toBe(true);
    const somme = score.parCategorie.reduce((acc, c) => acc + c.psi, 0);
    expect(somme).toBeCloseTo(score.psi, 12);
  });

  it("zone de surveillance : 50/50 → 70/30 = PSI ≈ 0,1695", () => {
    const score = calculerScorePsi({ a: 50, b: 50 }, { a: 70, b: 30 });
    expect(score.psi).toBeCloseTo(0.1694595721, 6);
    expect(score.statut).toBe("surveillance");
  });

  it("zone stable : 50/50 → 60/40 = PSI ≈ 0,0405", () => {
    const score = calculerScorePsi({ a: 50, b: 50 }, { a: 60, b: 40 });
    expect(score.psi).toBeCloseTo(0.0405465108, 6);
    expect(score.statut).toBe("stable");
  });

  it("catégories disjointes : epsilon de substitution, score FINI et dérivé", () => {
    const score = calculerScorePsi(
      { INTENTION_GENERALE: 100 },
      { GENERER_IMAGE: 100 },
    );
    expect(Number.isFinite(score.psi)).toBe(true);
    expect(score.psi).toBeGreaterThan(SEUIL_PSI_SURVEILLANCE);
    expect(score.statut).toBe("derive");
    // L'union des catégories est triée alphabétiquement (déterminisme).
    expect(score.parCategorie.map((c) => c.categorie)).toEqual([
      "GENERER_IMAGE",
      "INTENTION_GENERALE",
    ]);
  });

  it("côté vide : PAS de preuve de dérive sans données (psi 0, stable)", () => {
    const sansReference = calculerScorePsi({}, { GENERER_IMAGE: 10 });
    expect(sansReference.psi).toBe(0);
    expect(sansReference.statut).toBe("stable");
    expect(sansReference.echantillonsReference).toBe(0);
    expect(sansReference.echantillonsObserve).toBe(10);

    const sansObserve = calculerScorePsi({ GENERER_IMAGE: 10 }, {});
    expect(sansObserve.psi).toBe(0);
    expect(sansObserve.statut).toBe("stable");
  });

  it("statutPsi : bornes des seuils (0,1 et 0,25 INCLUSes en surveillance)", () => {
    expect(statutPsi(SEUIL_PSI_STABLE - 0.001)).toBe("stable");
    expect(statutPsi(SEUIL_PSI_STABLE)).toBe("surveillance");
    expect(statutPsi(SEUIL_PSI_SURVEILLANCE)).toBe("surveillance");
    expect(statutPsi(SEUIL_PSI_SURVEILLANCE + 0.001)).toBe("derive");
  });

  it("comptages invalides (NaN, négatifs) ignorés dans les totaux", () => {
    const score = calculerScorePsi({ a: 10, b: Number.NaN }, { a: 5, c: -3 });
    expect(score.echantillonsReference).toBe(10);
    expect(score.echantillonsObserve).toBe(5);
    // a : 100 % des deux côtés → contribution nulle.
    expect(score.psi).toBeCloseTo(0, 9);
  });
});

describe("accumulateur de comptages (lib/mlops/drift)", () => {
  it("enregistrer + snapshot : copie défensive et total exact", () => {
    const accumulateur = new AccumulateurDerive({ chemin: null });
    accumulateur.enregistrer("GENERER_IMAGE");
    accumulateur.enregistrer("GENERER_IMAGE", 2);
    accumulateur.enregistrer("INTENTION_GENERALE", 3.5);

    const instantane = accumulateur.snapshot();
    expect(instantane).toEqual({ GENERER_IMAGE: 3, INTENTION_GENERALE: 3.5 });
    expect(accumulateur.total()).toBe(6.5);
    expect(accumulateur.taille()).toBe(2);

    // Muter le snapshot ne touche pas l'accumulateur.
    instantane.GENERER_IMAGE = 999;
    expect(accumulateur.snapshot().GENERER_IMAGE).toBe(3);
  });

  it("garde douce : catégories vides et poids invalides ignorés", () => {
    const accumulateur = new AccumulateurDerive({ chemin: null });
    accumulateur.enregistrer("", 5);
    accumulateur.enregistrer("a", 0);
    accumulateur.enregistrer("a", -1);
    accumulateur.enregistrer("a", Number.NaN);
    accumulateur.enregistrer("b", Number.POSITIVE_INFINITY);
    expect(accumulateur.snapshot()).toEqual({});
  });

  it("cap de catégories : au-delà, regroupement dans « __autres »", () => {
    const accumulateur = new AccumulateurDerive({
      chemin: null,
      capCategories: 2,
    });
    accumulateur.enregistrer("a");
    accumulateur.enregistrer("b");
    accumulateur.enregistrer("c"); // dépasse le cap → __autres
    accumulateur.enregistrer("c"); // c hors cap → encore __autres
    const instantane = accumulateur.snapshot();
    expect(instantane["a"]).toBe(1);
    expect(instantane["b"]).toBe(1);
    expect(instantane[CATEGORIE_AUTRES]).toBe(2);
    expect(instantane["c"]).toBeUndefined();
  });

  it("fusionner + reinitialiser : reprise après redémarrage et nouvelle fenêtre", () => {
    const accumulateur = new AccumulateurDerive({ chemin: null });
    accumulateur.enregistrer("a", 4);
    accumulateur.fusionner({ a: 1, b: 2, invalide: Number.NaN });
    expect(accumulateur.snapshot()).toEqual({ a: 5, b: 2 });

    accumulateur.reinitialiser();
    expect(accumulateur.snapshot()).toEqual({});
    expect(accumulateur.total()).toBe(0);
  });

  it("persistance atomique : sauvegarder → charger à l'identique, aucun .tmp résiduel", async () => {
    const chemin = cheminStatsTest();
    const source = new AccumulateurDerive({ chemin });
    source.enregistrer("GENERER_IMAGE", 7);
    source.enregistrer("INTENTION_GENERALE", 3);
    expect(await source.sauvegarder()).toBe(true);
    expect(existsSync(chemin)).toBe(true);
    expect(readdirSync(join(chemin, "..")).filter((f) => f.includes(".tmp"))).toEqual([]);

    const relu = await AccumulateurDerive.charger({ chemin });
    expect(relu.snapshot()).toEqual(source.snapshot());
  });

  it("persistance tolérante : fichier absent/corrompu → accumulateur vide", async () => {
    const chemin = cheminStatsTest();
    expect((await AccumulateurDerive.charger({ chemin })).total()).toBe(0);

    writeFileSync(chemin, "{ comptages tronqués", "utf8");
    const corrompu = await AccumulateurDerive.charger({ chemin });
    expect(corrompu.total()).toBe(0);
    expect(corrompu.taille()).toBe(0);
  });

  it("persistance désactivée (chemin null) : sauvegarder est un no-op", async () => {
    const accumulateur = new AccumulateurDerive({ chemin: null });
    accumulateur.enregistrer("a");
    expect(await accumulateur.sauvegarder()).toBe(true);
  });

  it("accumulateurDeriveGlobal : singleton stable (future endpoint métriques)", () => {
    expect(accumulateurDeriveGlobal()).toBe(accumulateurDeriveGlobal());
  });
});
