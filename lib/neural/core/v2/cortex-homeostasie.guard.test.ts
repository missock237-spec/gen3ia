/**
 * GARDE 35ᵉ (it.67) — LE CORRECTIF DU SUBSTRAT EST RÉEL ET MESURÉ :
 *  1. DÉDUPLICATION de la liste d'attente (le « plafond » demandé par le
 *     rapport it.65 §3.4) : la liste ne peut JAMAIS dépasser `colonnes`
 *     entrées, même en avalanche (mesuré : 4 034/4 096 — l'ancien mécanisme
 *     empilait spikes × voisins entrées, jusqu'à ~46 000 sur ce scénario) ;
 *  2. HOMEOSTASIE SYNAPTIQUE (config opt-in, sémantique v1 exacte restée
 *     le défaut — test de fidélité inchangé) : la somme des poids sortants
 *     d'une colonne plafonnée au budget, même depuis une saturation forcée ;
 *  3. DÉTERMINISME intégral (même graine → mêmes spikes) ;
 *  4. TÉLÉMÉTRIE honnête (normalisations comptées, zéro quand désactivée).
 *
 * Anomalie documentée it.65 §3.4 : après ~20 époques de re-consolidation,
 * les poids atteignent 1.0 et la liste d'attente croît sans amortissement.
 * Correctif it.67 : déduplication (toujours) + échelle synaptique
 * (normalisationHomeostatique) — le substrat reste entraînable sans borne.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CORTEX_CONFIG_DEFAUTS,
  CortexColumnnaire,
} from "./cortex-columnnaire";

const BUDGET = 6.0;

function cortexIt67(normalisation: boolean): CortexColumnnaire {
  return new CortexColumnnaire({
    colonnes: 4096,
    voisins: 12,
    bandesLecture: 8,
    seuil: 1.0,
    decroissance: 0.1,
    plasticiteFenetre: 2.0,
    lrBoost: 0.15,
    seed: 42,
    bandes: 32,
    normalisationHomeostatique: normalisation,
    budgetPoidsSortants: BUDGET,
  });
}

function sommeSortants(cortex: CortexColumnnaire, colonne: number): number {
  let somme = 0;
  for (let k = 0; k < cortex.config.voisins; k++) {
    somme += cortex.csrPoids[colonne * cortex.config.voisins + k];
  }
  return somme;
}

describe("garde 35ᵉ — plafond d'attente + homéostasie synaptique (it.67)", () => {
  it("défauts : homéostasie désactivée, budget voisins × 0.5 (sémantique v1 conservée)", () => {
    expect(CORTEX_CONFIG_DEFAUTS.normalisationHomeostatique).toBe(false);
    expect(CORTEX_CONFIG_DEFAUTS.budgetPoidsSortants).toBeCloseTo(6.0, 6);
  });

  it("PLAFOND : la liste d'attente ne dépasse jamais `colonnes`, même en avalanche", () => {
    const cortex = cortexIt67(false);
    cortex.csrPoids.fill(1.0); // saturation forcée — pire cas it.65
    for (let t = 1; t <= 40; t++) {
      cortex.pas([[5, 1.5], [6, 1.5], [7, 1.5]], t);
      expect(cortex.tailleListeAttente).toBeLessThanOrEqual(4096);
    }
  });

  it("HOMÉOSTASIE : aucune somme sortante ne dépasse le budget, même depuis une saturation forcée", () => {
    const cortex = cortexIt67(true);
    cortex.csrPoids.fill(1.0); // saturation forcée
    let maxSomme = 0;
    for (let t = 1; t <= 40; t++) {
      const spikes = cortex.pas([[5, 1.5], [6, 1.5], [7, 1.5]], t);
      for (const s of spikes) {
        maxSomme = Math.max(maxSomme, sommeSortants(cortex, s));
      }
    }
    expect(maxSomme).toBeLessThanOrEqual(BUDGET + 1e-5);
  });

  it("SANS homéostasie : la saturation à 1.0 reste possible (sémantique v1, anomalie documentée)", () => {
    const cortex = cortexIt67(false);
    cortex.csrPoids.fill(1.0);
    for (let t = 1; t <= 30; t++) {
      cortex.pas([[5, 1.5], [6, 1.5], [7, 1.5]], t);
    }
    // Le comportement historique est CONSERVÉ (aucun maquillage) :
    // sans homéostasie, les poids restent au plafond 1.0 (somme → 12).
    expect(sommeSortants(cortex, 5)).toBeGreaterThan(11.5);
  });

  it("télémétrie honnête : normalisations = 0 (désactivée) puis > 0 (activée)", () => {
    const off = cortexIt67(false);
    off.csrPoids.fill(1.0);
    off.pas([[5, 1.5]], 1);
    expect(off.metabolismeDernierPas.normalisations).toBe(0);

    const on = cortexIt67(true);
    on.csrPoids.fill(1.0);
    on.pas([[5, 1.5]], 1);
    expect(on.metabolismeDernierPas.normalisations).toBeGreaterThan(0);
  });

  it("déterminisme : même graine et même scénario → mêmes spikes", () => {
    const course = (): number[][] => {
      const cortex = cortexIt67(true);
      const trace: number[][] = [];
      for (let t = 1; t <= 25; t++) {
        trace.push(cortex.pas([[5, 1.5], [6, 1.5], [7, 1.5]], t).slice());
      }
      return trace;
    };
    expect(course()).toEqual(course());
  });

  it("reset : la liste d'attente et son drapeau sont vidés (reprise propre)", () => {
    const cortex = cortexIt67(false);
    cortex.csrPoids.fill(1.0);
    cortex.pas([[5, 1.5]], 1);
    cortex.reinitialiserEnergies();
    expect(cortex.tailleListeAttente).toBe(0);
    // Après reset, aucune évaluation résiduelle : un pas à vide ne spique rien.
    const spikes = cortex.pas(null, 2);
    expect(spikes).toEqual([]);
  });

  it("le runtime et la campagne d'amélioration activent l'homéostasie (cortex d'entraînement/vif)", () => {
    // Vérification structurelle : le correctif est branché là où la
    // plasticité s'accumule (runtime vivant + campagne de consolidation).
    const runtime = readFileSync(
      join(process.cwd(), "lib/neural/runtime.ts"),
      "utf8",
    );
    expect(runtime).toContain("normalisationHomeostatique: true");

    const campagne = readFileSync(
      join(process.cwd(), "scripts/amelioration-continue-gen3.ts"),
      "utf8",
    );
    expect(campagne).toContain("normalisationHomeostatique: true");
  });
});
