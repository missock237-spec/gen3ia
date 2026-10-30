import { describe, expect, it } from "vitest";

import {
  analyserOndeTexte,
  bandeDuDomaine,
  colonnesDepuisOndes,
  entrainerDomainesParOndes,
  porteurBande,
} from "./entrainement-ondes";
import { CortexColumnnaire } from "../core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../core/v2/champ-cortical";

/**
 * ENTRAÎNEMENT PAR ONDES DE DOMAINE (it.57) — méthode d'entraînement par
 * ANALYSE DES ONDES puis TRAITEMENT DES ONDES, sur les domaines CHOISIS.
 * Module pur, déterministe : même entrée → même rapport.
 */

/** Petit cortex de test : 4096 colonnes, 2 voisins (rapide, déterministe). */
function petitCortex(): CortexColumnnaire {
  return new CortexColumnnaire({ colonnes: 4096, voisins: 2, seed: 42, bandes: 8 });
}

describe("Entraînement par ondes de domaine (it.57)", () => {
  it("analyse des ondes : signature déterministe, distincte entre textes, vocabulaire borné", () => {
    const a1 = analyserOndeTexte("entraîne gen3 sur les mathématiques", 0);
    const a2 = analyserOndeTexte("entraîne gen3 sur les mathématiques", 0);
    const b = analyserOndeTexte("écris un poème sur la mer", 0);
    // Même texte → MÊME signature (reproductible).
    expect(a1).toEqual(a2);
    expect(a1.length).toBeGreaterThan(0);
    // Textes distincts → signatures distinctes.
    expect(a1).not.toEqual(b);
    // Chaque paquet respecte le vocabulaire des ondes (porteur + phase + amplitude).
    for (const p of a1) {
      expect(p.frequence).toBeGreaterThanOrEqual(0.25);
      expect(p.frequence).toBeLessThanOrEqual(1.75);
      expect(p.amplitude).toBeGreaterThan(0);
      expect(p.amplitude).toBeLessThanOrEqual(1);
      expect(Number.isFinite(p.phase)).toBe(true);
    }
  });

  it("traitement des ondes : la phase et la fréquence DÉCIDENT la colonne cible", () => {
    const injections = colonnesDepuisOndes(
      [
        { region: 0, frequence: 0.25, phase: 0, amplitude: 1 },
        { region: 0, frequence: 1.75, phase: Math.PI, amplitude: 1 },
      ],
      4096,
    );
    expect(injections.length).toBeGreaterThan(0);
    // Intensité = amplitude × INTENSITE_TOKEN_CORTEX (cap 3.0).
    for (const [, intensite] of injections) {
      expect(intensite).toBeGreaterThan(0);
      expect(intensite).toBeLessThanOrEqual(3.0);
    }
    // Déterminisme : même onde → mêmes colonnes.
    const bis = colonnesDepuisOndes(
      [
        { region: 0, frequence: 0.25, phase: 0, amplitude: 1 },
        { region: 0, frequence: 1.75, phase: Math.PI, amplitude: 1 },
      ],
      4096,
    );
    expect(injections).toEqual(bis);
  });

  it("session complète : chaque domaine a son porteur, le rapport est honnête et le métabolisme mesuré", () => {
    const cortex = petitCortex();
    const champ = new ChampCorticalGen3(42);
    const exemples = [
      { texte: "résous une équation du second degré pas à pas", domaine: "mathematiques" },
      { texte: "calcule la dérivée d'une fonction composée", domaine: "mathematiques" },
      { texte: "écris une fonction qui trie une liste en python", domaine: "programmation" },
      { texte: "corrige la fuite mémoire de cette boucle", domaine: "programmation" },
    ];
    const rapport = entrainerDomainesParOndes(cortex, champ, exemples, { cyclesParEchantillon: 2 });

    // Deux domaines choisis, chacun avec sa bande-porteuse et son porteur.
    expect(rapport.domaines).toHaveLength(2);
    const domaines = rapport.domaines.map((d) => d.domaine).sort();
    expect(domaines).toEqual(["mathematiques", "programmation"]);
    for (const d of rapport.domaines) {
      expect(d.bande).toBe(bandeDuDomaine(d.domaine));
      expect(d.porteurFrequence).toBeCloseTo(porteurBande(d.bande), 5);
      expect(d.echantillons).toBe(2);
      expect(d.paquetsEmis).toBeGreaterThan(0);
      expect(d.resonanceMoyenne).toBeGreaterThanOrEqual(0);
    }
    // Métabolisme RÉEL cumulé (les pas ont tourné) + total honnête.
    expect(rapport.totalEchantillons).toBe(4);
    expect(rapport.metabolisme.evaluees).toBeGreaterThan(0);
    expect(rapport.metabolisme.transmissions).toBeGreaterThan(0);
    expect(rapport.metabolisme.ms).toBeGreaterThanOrEqual(0);
    // La propagation d'ondes a bien travaillé dans le champ (modulation non nulle).
    const modulation = champ.modulationRegionale();
    expect(modulation.some((m) => m > 0)).toBe(true);
  });

  it("garde-fous : domaines invalides ignorés, cap par domaine, zéro exemple = zéro travail", () => {
    const cortex = petitCortex();
    const champ = new ChampCorticalGen3(42);
    // Exemples vides / invalides → rapport vide, métabolisme nul.
    const rapport = entrainerDomainesParOndes(cortex, champ, [
      { texte: "   ", domaine: "math" },
      { texte: "ok", domaine: "" },
    ]);
    expect(rapport.domaines).toHaveLength(0);
    expect(rapport.totalEchantillons).toBe(0);
    expect(rapport.metabolisme.transmissions).toBe(0);
    // Cap par domaine honnête (maxParDomaine = 3 sur 5 exemples).
    const exemples = Array.from({ length: 5 }, (_, i) => ({
      texte: `exemple d'entraînement numéro ${i}`,
      domaine: "unique",
    }));
    const rapport2 = entrainerDomainesParOndes(cortex, champ, exemples, { maxParDomaine: 3, cyclesParEchantillon: 1 });
    expect(rapport2.domaines[0].echantillons).toBe(3);
    expect(rapport2.totalEchantillons).toBe(3);
  });
});
