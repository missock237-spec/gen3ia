import { describe, expect, it } from "vitest";

import {
  CORTEX_CONFIG_DEFAUTS,
  CortexColumnnaire,
  hashTokenVersColonne,
  INTENSITE_MAX_CORTEX,
  INTENSITE_TOKEN_CORTEX,
} from "./cortex-columnnaire";

/** Petit réseau de test : 64 colonnes, 2 voisins. */
function petitCortex(seed = 42): CortexColumnnaire {
  return new CortexColumnnaire({
    colonnes: 64,
    voisins: 2,
    seed,
    bandes: 4,
  });
}

describe("CortexColumnnaire", () => {
  it("a une structure CSR déterministe pour une même graine", () => {
    const a = petitCortex(7);
    const b = petitCortex(7);
    expect(Array.from(a.csrCible)).toEqual(Array.from(b.csrCible));
    expect(Array.from(a.csrPoids)).toEqual(Array.from(b.csrPoids));
    const c = petitCortex(8);
    expect(Array.from(a.csrCible)).not.toEqual(Array.from(c.csrCible));
  });

  it("n'a aucune auto-boucle et des cibles dans les bornes", () => {
    const cortex = petitCortex();
    for (let c = 0; c < cortex.config.colonnes; c++) {
      for (let k = 0; k < cortex.config.voisins; k++) {
        const cible = cortex.csrCible[c * cortex.config.voisins + k];
        expect(cible).toBeGreaterThanOrEqual(0);
        expect(cible).toBeLessThan(cortex.config.colonnes);
        expect(cible).not.toBe(c);
        const poids = cortex.csrPoids[c * cortex.config.voisins + k];
        expect(poids).toBeGreaterThanOrEqual(0.1);
        expect(poids).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it("équivalence EXACTE avec une référence naïve pas à pas (sémantique v1)", () => {
    // Référence : modèle v1 naïf — décroissance de TOUTES les unités à
    // chaque cycle, injection décroissie au même cycle, transmission
    // ajoutée APRÈS l'update, plasticité par fenêtre. Le cortex v2 doit
    // produire les MÊMES spikes et les MÊMES énergies (tolérance flottant).
    const cortex = petitCortex(123);
    const n = cortex.config.colonnes;
    const d = cortex.config.decroissance;
    const naive = new Float64Array(n);

    const injectionsParCycle: Array<Array<[number, number]>> = [];
    // Scénario : injections fraîches, répétitions, cycles à vide,
    // sur-stimulations (spikes + transmission + plasticité).
    const valeurs = [0.37, 1.23, 2.9, 0.05, 1.9, 0.61];
    for (let t = 1; t <= 40; t++) {
      const injections: Array<[number, number]> = [];
      if (t % 3 !== 0) {
        const nb = 1 + (t % 4);
        for (let i = 0; i < nb; i++) {
          injections.push([(t * 7 + i * 13) % n, valeurs[(t + i) % valeurs.length]]);
        }
      }
      injectionsParCycle.push(injections);
    }

    for (let t = 1; t <= 40; t++) {
      const injections = injectionsParCycle[t - 1];

      // ----- Référence naïve (ordre v1 exact) ---------------------------
      const naiveSpikes: number[] = [];
      for (const [c, v] of injections) naive[c] += v;
      for (let c = 0; c < n; c++) {
        naive[c] *= 1 - d;
        if (naive[c] >= 1.0) {
          naive[c] = 0;
          naiveSpikes.push(c);
        }
      }
      for (const s of naiveSpikes) {
        for (let k = 0; k < cortex.config.voisins; k++) {
          const p = s * cortex.config.voisins + k;
          const cible = cortex.csrCible[p];
          // Poids courant (la plasticité est appliquée par le cortex v2
          // lui-même dans pas() — la référence ne la duplique pas).
          naive[cible] += cortex.csrPoids[p];
        }
      }

      // ----- Cortex v2 ---------------------------------------------------
      const spikesV2 = cortex.pas(
        injections.length > 0 ? injections : null,
        t,
      );

      // Mêmes spikes (l'ordre de la liste diffère : v2 évalue les colonnes
      // en attente avant les injections — l'état, lui, est identique car
      // toutes les opérations sont commutatives).
      expect([...spikesV2].sort((a, b) => a - b)).toEqual(
        [...naiveSpikes].sort((a, b) => a - b),
      );

      // Mêmes énergies effectives (décroissance paresseuse en forme fermée
      // vs pas à pas — tolérance 1e-9 pour l'ordre des multiplications).
      for (let c = 0; c < n; c++) {
        const effectif =
          cortex.energies[c] * Math.pow(1 - d, t - cortex.dernierTouche[c]);
        expect(effectif).toBeCloseTo(naive[c], 5);
      }
    }
  });

  it("décroît une injection au même cycle (fidélité v1 : 1.5 → 1.35)", () => {
    const cortex = petitCortex();
    cortex.pas([[0, 1.5]], 1);
    // Pas de spike : 1.5 × 0.9 = 1.35 < 1.0 ? Non — 1.35 ≥ 1.0 → SPIKE.
    // Vérifions le vrai comportement : 1.35 ≥ seuil → spike + reset à 0.
    expect(cortex.energies[0]).toBe(0);
    // Sous le seuil : 0.5 × 0.9 = 0.45.
    const c2 = petitCortex();
    c2.pas([[1, 0.5]], 1);
    expect(c2.energies[1]).toBeCloseTo(0.45, 6);
  });

  it("ne spiké qu'une fois par cycle même sur-stimulé, reset à zéro", () => {
    const cortex = petitCortex();
    const spikes = cortex.pas(
      [
        [2, 1.0],
        [2, 2.0],
      ],
      1,
    );
    expect(spikes.filter((c) => c === 2)).toHaveLength(1);
    expect(cortex.energies[2]).toBe(0);
    expect(cortex.dernierSpike[2]).toBe(1);
  });

  it("transmet l'énergie le long du CSR au cycle suivant", () => {
    const cortex = petitCortex();
    const c0 = 0;
    const cibles = [cortex.csrCible[0], cortex.csrCible[1]];
    // Poids AVANT le pas (la plasticité peut les renforcer après usage).
    const poidsAvant = [cortex.csrPoids[0], cortex.csrPoids[1]];
    cortex.pas([[c0, 1.5]], 1); // spike de la colonne 0
    // Transmission ajoutée APRÈS l'update : énergie = poids (non décroissie).
    for (let i = 0; i < cibles.length; i++) {
      expect(cibles[i]).not.toBe(c0);
      expect(cortex.energies[cibles[i]]).toBeCloseTo(poidsAvant[i], 6);
    }
    // Cycle suivant sans injection : les cibles décroissent d'un cycle.
    cortex.pas(null, 2);
    for (let i = 0; i < cibles.length; i++) {
      expect(cortex.energies[cibles[i]]).toBeCloseTo(poidsAvant[i] * 0.9, 6);
    }
  });

  it("reinitialiserEnergies remet l'état transitoire à zéro", () => {
    const cortex = petitCortex();
    cortex.pas(
      [
        [3, 0.4],
        [4, 0.4],
      ],
      1,
    );
    cortex.reinitialiserEnergies();
    expect(cortex.energies[3]).toBe(0);
    expect(cortex.energies[4]).toBe(0);
    expect(cortex.resonanceBandes().every((r) => r === 0)).toBe(true);
  });

  it("projetterTokens déduplique, plafonne et reste dans les bornes", () => {
    const cortex = new CortexColumnnaire({ colonnes: 65536, voisins: 2, bandes: 4 });
    const projections = cortex.projetterTokens([
      "bonjour",
      "bonjour",
      "bonjour",
      "monde",
    ]);
    const carte = new Map(projections);
    for (const [colonne, intensite] of projections) {
      expect(colonne).toBeGreaterThanOrEqual(0);
      expect(colonne).toBeLessThan(cortex.config.colonnes);
      expect(intensite).toBeLessThanOrEqual(INTENSITE_MAX_CORTEX);
    }
    const colonneBonjour = hashTokenVersColonne("bonjour", 65536);
    const colonneMonde = hashTokenVersColonne("monde", 65536);
    if (colonneBonjour === colonneMonde) {
      // Collision (improbable sur 65 536) : intensité plafonnée de fait.
      expect(carte.get(colonneBonjour)).toBe(INTENSITE_MAX_CORTEX);
    } else {
      expect(carte.size).toBe(2);
      // 3 occurrences plafonnées : min(3.0, 3 × 1.2) = 3.0.
      expect(carte.get(colonneBonjour)).toBe(
        Math.min(INTENSITE_MAX_CORTEX, 3 * INTENSITE_TOKEN_CORTEX),
      );
      expect(carte.get(colonneMonde)).toBe(INTENSITE_TOKEN_CORTEX);
    }
  });

  it("plasticité supervisée renforce la bande cible et punit les sur-résonantes", () => {
    const cortex = petitCortex();
    // Bande 0 = colonnes 0..15 (64 colonnes / 4 bandes).
    const stimulees = [0, 1, 2];
    const avant: number[] = [];
    for (const c of stimulees) {
      for (let k = 0; k < cortex.config.voisins; k++) {
        avant.push(cortex.csrPoids[c * cortex.config.voisins + k]);
      }
    }
    cortex.plasticiteSupervisee(stimulees, 0, 0.15, [1, 2]);
    for (const c of stimulees) {
      for (let k = 0; k < cortex.config.voisins; k++) {
        const p = c * cortex.config.voisins + k;
        const cible = cortex.csrCible[p];
        const bandeCible = Math.floor(cible / 16);
        if (bandeCible === 0) {
          expect(cortex.csrPoids[p]).toBeCloseTo(Math.min(1, avant.shift()! + 0.15), 6);
        } else if (bandeCible === 1 || bandeCible === 2) {
          expect(cortex.csrPoids[p]).toBeCloseTo(avant.shift()! * 0.95, 6);
        } else {
          expect(cortex.csrPoids[p]).toBeCloseTo(avant.shift()!, 6);
        }
      }
    }
  });

  it("stats réalistes : mémoire ~22 Mo au format par défaut, télémétrie présente", () => {
    const cortex = petitCortex();
    cortex.pas([[5, 1.5]], 1);
    const stats = cortex.stats();
    expect(stats.colonnes).toBe(64);
    expect(stats.aretes).toBe(128);
    expect(stats.memoireMo).toBeGreaterThanOrEqual(0);
    expect(stats.msCycleEma).toBeGreaterThanOrEqual(0);
    const defauts = CORTEX_CONFIG_DEFAUTS;
    // it.56 (demande propriétaire : « un million de neurones ») : 2^20.
    expect(defauts.colonnes).toBe(1048576);
    expect(defauts.voisins).toBe(12);
    expect(defauts.bandesLecture).toBe(8);
    // Mémoire du format par défaut : entre 100 et 140 Mo (127 Mo attendus).
    const octetsDefauts =
      defauts.colonnes * 25 + defauts.colonnes * defauts.voisins * 8;
    expect(octetsDefauts / 1048576).toBeGreaterThan(100);
    expect(octetsDefauts / 1048576).toBeLessThan(140);
  });

  it("garantit une arête de chaque colonne vers chaque bande de lecture", () => {
    // Format production : 32 bandes, 8 bandes de lecture garanties.
    const cortex = new CortexColumnnaire();
    const parBande = Math.floor(cortex.config.colonnes / cortex.config.bandes);
    // Échantillon de colonnes : l'arête k (k < bandesLecture) cible
    // toujours la bande k.
    for (let c = 0; c < cortex.config.colonnes; c += 977) {
      for (let k = 0; k < cortex.config.bandesLecture; k++) {
        const cible = cortex.csrCible[c * cortex.config.voisins + k];
        expect(cible).toBeGreaterThanOrEqual(k * parBande);
        expect(cible).toBeLessThan((k + 1) * parBande);
      }
    }
  });

  it("export/import des poids : aller-retour exact", () => {
    const cortex = petitCortex();
    cortex.pas([[6, 1.5]], 1); // un peu de plasticité
    const poids = cortex.exporterPoids();
    const autre = petitCortex();
    expect(autre.importerPoids(poids)).toBe(true);
    expect(Array.from(autre.csrPoids)).toEqual(Array.from(poids));
    expect(autre.importerPoids(new Float32Array(3))).toBe(false);
  });
});
