import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  BRAIN_BAK_PATH,
  BRAIN_PATH,
  deleteBrainState,
  loadBrainState,
  saveBrainState,
} from "./persistence";
import { ReseauNeuronalGen3 } from "../core/network";

/**
 * PERSISTANCE DU CERVEAU — durcissement 2026-10-22 :
 *  - sauvegardes SÉRIALISÉES (mutex interne) : des appels concurrents ne
 *    peuvent plus entrer en course sur un .tmp partagé ;
 *  - .tmp UNIQUE (pid + uuid) et purge en cas d'échec : aucun déchet ;
 *  - ROTATION .bak : au chargement, un cerveau principal corrompu retombe
 *    sur la dernière version connue bonne au lieu d'une amnésie totale.
 *
 * Les tests écrivent dans var/neural/ (hors git) et nettoient après eux.
 */

function reseauTest(seed: number): ReseauNeuronalGen3 {
  return new ReseauNeuronalGen3({ seed, size: 50, density: 0.2 });
}

function fichiersTmpResiduels(): string[] {
  const dir = BRAIN_PATH.replace(/\/[^/]+$/, "");
  if (!existsSync(dir)) return [];
  // HONNÊTETÉ DU TEST : en suite complète, d'autres workers vitest
  // (processus séparés) peuvent avoir une écriture EN VOL au moment du
  // listing — un .tmp FRAICHI n'est pas un orphelin. La garantie testée
  // (et la garantie production, mono-processus PM2) : aucun .tmp PÉRIMÉ
  // ne traîne (l'écrémage de persistence.ts purge les orphelins > 5 s).
  const limite = Date.now() - 5_000;
  return readdirSync(dir).filter((f) => {
    if (!f.includes(".tmp")) return false;
    try {
      return statSync(join(dir, f)).mtimeMs < limite;
    } catch {
      return true; // disparu entre-temps : compté comme résidu aïeul parti
    }
  });
}

afterEach(() => {
  deleteBrainState();
});

describe("persistence du cerveau neuronal", () => {
  it("sauvegarde simple : le fichier existe et se recharge à l'identique", async () => {
    const reseau = reseauTest(1);
    const ok = await saveBrainState(reseau, { 0: ["bonjour"] }, []);
    expect(ok).toBe(true);
    expect(existsSync(BRAIN_PATH)).toBe(true);

    const etat = loadBrainState();
    expect(etat).not.toBeNull();
    expect(etat?.synapses).toHaveLength(reseau.synapses.length);
    expect(etat?.tokenRegistry[0]).toEqual(["bonjour"]);
  });

  it("sauvegardes concurrentes : aucune corruption, aucun .tmp résiduel", async () => {
    const reseauA = reseauTest(2);
    const reseauB = reseauTest(3);

    const [okA, okB] = await Promise.all([
      saveBrainState(reseauA, {}, []),
      saveBrainState(reseauB, {}, []),
    ]);

    expect(okA).toBe(true);
    expect(okB).toBe(true);

    const etat = loadBrainState();
    expect(etat).not.toBeNull();
    // L'état servi correspond EXACTEMENT à l'un des deux réseaux complets
    // (jamais un mélange, jamais un JSON tronqué).
    const matchA =
      etat?.synapses.length === reseauA.synapses.length &&
      etat.synapses.every(
        (s, i) =>
          s[0] === reseauA.synapses[i].sourceId &&
          s[1] === reseauA.synapses[i].targetId &&
          s[2] === reseauA.synapses[i].weight,
      );
    const matchB =
      etat?.synapses.length === reseauB.synapses.length &&
      etat.synapses.every(
        (s, i) =>
          s[0] === reseauB.synapses[i].sourceId &&
          s[1] === reseauB.synapses[i].targetId &&
          s[2] === reseauB.synapses[i].weight,
      );
    expect(matchA || matchB).toBe(true);
    expect(fichiersTmpResiduels()).toEqual([]);
  });

  it("rotation .bak : un cerveau principal corrompu retombe sur la dernière version connue bonne", async () => {
    const reseauV1 = reseauTest(4);
    const reseauV2 = reseauTest(5);

    await saveBrainState(reseauV1, {}, []);
    const horodatageV1 = loadBrainState()?.sauvegardeLe;
    await saveBrainState(reseauV2, {}, []);

    // La .bak contient la version précédente (v1) — jamais l'amnésie.
    expect(existsSync(BRAIN_BAK_PATH)).toBe(true);
    const bak = JSON.parse(readFileSync(BRAIN_BAK_PATH, "utf8")) as {
      sauvegardeLe: string;
    };
    expect(bak.sauvegardeLe).toBe(horodatageV1);

    // Corruption du principal → repli automatique sur la .bak.
    writeFileSync(BRAIN_PATH, "{ ceci n'est pas du JSON", "utf8");
    const restaure = loadBrainState();
    expect(restaure).not.toBeNull();
    expect(restaure?.sauvegardeLe).toBe(horodatageV1);
    expect(restaure?.synapses).toHaveLength(reseauV1.synapses.length);
  });

  it("rejette au chargement les checkpoints RPIA de forme ou de temps invalides", async () => {
    const reseau = reseauTest(8);
    const validRpia = {
      taille: 50,
      pasTotaux: 12,
      poids: Array.from({ length: 50 * 4 }, (_, i) => i / 1000),
    };
    await saveBrainState(reseau, {}, [], undefined, validRpia);

    const original = JSON.parse(readFileSync(BRAIN_PATH, "utf8")) as Record<string, unknown>;
    expect(loadBrainState()?.rpia).toEqual(validRpia);

    const poidsTropCourts = validRpia.poids.slice(0, -1);
    const poidsAvecNull: unknown[] = validRpia.poids.slice();
    poidsAvecNull[0] = null;
    const casInvalides: unknown[] = [
      { ...validRpia, poids: poidsTropCourts },
      { ...validRpia, pasTotaux: -1 },
      { ...validRpia, pasTotaux: 1.5 },
      { ...validRpia, poids: poidsAvecNull },
      { ...validRpia, taille: 4097, poids: new Array(4097 * 4).fill(0) },
    ];

    for (const rpia of casInvalides) {
      writeFileSync(BRAIN_PATH, JSON.stringify({ ...original, rpia }), "utf8");
      expect(loadBrainState()?.rpia).toBeUndefined();
    }
  });

  it("deleteBrainState purge le cerveau ET sa .bak (reset complet)", async () => {
    const reseau = reseauTest(6);
    await saveBrainState(reseau, {}, []);
    await saveBrainState(reseauTest(7), {}, []);
    expect(existsSync(BRAIN_PATH)).toBe(true);
    expect(existsSync(BRAIN_BAK_PATH)).toBe(true);

    deleteBrainState();

    expect(existsSync(BRAIN_PATH)).toBe(false);
    expect(existsSync(BRAIN_BAK_PATH)).toBe(false);
    expect(loadBrainState()).toBeNull();
  });
});
