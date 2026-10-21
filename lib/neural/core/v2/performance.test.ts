import { describe, expect, it } from "vitest";

import { CortexColumnnaire } from "./cortex-columnnaire";
import { ChampCorticalGen3 } from "./champ-cortical";
import { EffecteurCortexV2 } from "./effecteur-cortex";
import { ReseauNeuronalGen3 } from "../network";
import { tokenize } from "../../encoding/text-encoder";

/**
 * BENCHMARK NEURONAL — mesures réelles de vitesse, affichées dans la sortie
 * de test (`vitest run lib/neural/core/v2/performance.test.ts`). Les
 * assertions sont volontairement généreuses (CI partagée) ; les CHIFFRES
 * affichés sont les mesures honnêtes à comparer entre v1 et v2.
 */

/** Moyenne des temps (ms) sur `n` exécutions, après `echauffement`. */
function mesurer(n: number, echauffement: number, fn: () => void): number {
  for (let i = 0; i < echauffement; i++) fn();
  const debut = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - debut) / n;
}

describe("Benchmark neuronal (mesures réelles)", () => {
  it(
    "v2 : cycle columnnaire complet (262 144 unités) vs noyau v1 (100 neurones)",
    { timeout: 60_000 },
    () => {
      // ----- Noyau v1 (100 neurones, synapses denses d'origine) ----------
      // Unité de mesure = FENÊTRE RÉELLE : reset + 4 cycles (injection en
      // volée au cycle 1) — le régime exact d'une génération en production.
      const reseau = new ReseauNeuronalGen3({ seed: 42 });
      const inputs = { 0: 1.2, 5: 1.2, 20: 2.4 };
      const fenetreV1 = (): void => {
        for (const neurone of reseau.neurones.values()) neurone.energy = 0;
        for (let c = 0; c < 4; c++) {
          reseau.step(c === 0 ? inputs : {}, c + 1);
        }
      };
      const msV1 = mesurer(200, 20, fenetreV1);
      let tCycle = 0;

      // ----- Cortex v2 (262 144 colonnes, format production) -------------
      const cortex = new CortexColumnnaire();
      const tokens = tokenize(
        "génère une image d'un coucher de soleil sur l'océan avec des nuages roses",
      );
      const injections = cortex.projetterTokens(tokens);
      // L'HORLOGE AVANCE (comme en production : +1 par cycle) — la
      // décroissance éteint la cascade, le coût est celui du régime réel.
      const fenetreV2 = (): void => {
        cortex.reinitialiserEnergies();
        for (let c = 0; c < 4; c++) {
          tCycle += 1;
          cortex.pas(c === 0 ? injections : null, tCycle);
        }
      };
      const msV2 = mesurer(200, 20, fenetreV2);
      const msV2Cycle = msV2 / 4;

      // Cycle avec activité massive (1000 colonnes sur-stimulées → ~1000
      // spikes → 2M arêtes potentiellement touchées via CSR).
      const massif: Array<[number, number]> = [];
      for (let c = 0; c < 1000; c++) massif.push([c * 262, 3.0]);
      const msV2Massif = mesurer(50, 5, () => {
        cortex.reinitialiserEnergies();
        cortex.pas(massif, 1);
      });

      // ----- Champ cortical 1e9 : échantillonnage stratifié --------------
      const champ = new ChampCorticalGen3(42);
      const msChamp = mesurer(10, 2, () => {
        champ.echantillonner(1, 4096);
      });

      const rapport = {
        "v1_noyau_100_neurones_ms_par_fenetre_4_cycles": Number(msV1.toFixed(4)),
        "v2_cortex_262144_colonnes_ms_par_fenetre_4_cycles": Number(msV2.toFixed(4)),
        "v2_cortex_ms_par_cycle": Number(msV2Cycle.toFixed(4)),
        "v2_cycle_massif_1000_spikes_ms": Number(msV2Massif.toFixed(4)),
        "v2_champ_1e9_echantillon_4096_ms": Number(msChamp.toFixed(4)),
        "unites_traitees_v2_par_v1": Math.round(262144 / 100),
        "fenetres_v2_par_seconde": Math.round(1000 / msV2),
      };
      console.log("BENCHMARK NEURONAL:", JSON.stringify(rapport, null, 2));

      // Assertions généreuses (CI partagée) — la valeur est le CHIFFRE
      // affiché ci-dessus, pas le seuil.
      expect(msV2).toBeLessThan(50); // fenêtre complète (reset + 4 cycles) < 50 ms
      expect(msV2Massif).toBeLessThan(150); // cycle massif < 150 ms
      expect(msChamp).toBeLessThan(100); // échantillon 1e9 < 100 ms
      // Le cortex v2 gère 2621× plus d'unités que le noyau v1 tout en
      // restant dans un facteur 100 du coût d'une fenêtre v1.
      expect(msV2).toBeLessThan(msV1 * 100 + 1);
    },
  );

  it(
    "intégration effecteur v2 + noyau v1 : génération complète rapide",
    { timeout: 30_000 },
    () => {
      const reseau = new ReseauNeuronalGen3({ seed: 42 });
      const cortex = new CortexColumnnaire();
      const champ = new ChampCorticalGen3(42);
      const effecteur = new EffecteurCortexV2(reseau, cortex, champ, 11);
      const fenetre = nouvelleFenetreLocal();
      const debut = performance.now();
      for (let cycle = 0; cycle < 4; cycle++) {
        effecteur.evaluerEtExecuter([], {
          prompt: "explique-moi la photosynthèse en détail",
          __fenetreNeuronale: fenetre,
        });
      }
      const msFenetre = performance.now() - debut;
      console.log(
        `Fenêtre complète (4 cycles, noyau 100 + cortex 262 144 + champ 1e9) : ${msFenetre.toFixed(2)} ms`,
      );
      expect(msFenetre).toBeLessThan(500);
      expect(effecteur.etatPourApi().horlogeColumnnaire).toBe(4);
    },
  );
});

/** Compteur local de fenêtres (le module d'effecteur garde le sien). */
function nouvelleFenetreLocal(): number {
  return Date.now() % 1000000 + Math.floor(Math.random() * 1000) + 100000;
}
