/**
 * MOTEUR MATÉRIEL D'ONDES — recommandation du propriétaire (volet matériel).
 *
 * « Les ressources matérielles apportées à Gen3 ne doivent JAMAIS servir à
 *  effectuer des opérations ou des calculs génériques : elles doivent
 *  servir à TRAITER les ondes produites par Gen3, à MIEUX LES ÉVALUER, pour
 *  permettre une plus haute qualité de résultat et augmenter la vitesse de
 *  traitement des données. »
 *
 * Ce module N'EXPOSE DONC AUCUNE entrée de calcul générique : sa seule
 * surface est l'ÉVALUATION DES ONDES (cohérence de Kuramoto, énergie,
 * latences de pics, gains de résonance, débit de pas). Le GPU (WebGPU,
 * fabrique creerMoteur de lib/ondes/moteur.ts) exécute la MÊME physique que
 * le miroir CPU : seule la VÉLOCITÉ change — qualité supérieure et vitesse
 * accrue, jamais un chemin de calcul parallèle.
 *
 * Sur un runtime sans WebGPU (sandbox, serveur headless), le repli CPU est
 * utilisé et rapporté HONNÊTEMENT — jamais de GPU simulé.
 */

import { creerMoteur, webgpuDisponible } from "@/lib/ondes/moteur";
import type { MoteurOndes } from "@/lib/ondes/champ";

import { CONFIG_FUSION, type NoeudOndesUnifie } from "./noeud-ondes-unifie";

export interface MesuresOndes {
  /** Moteur réellement utilisé pour l'évaluation (fabrique honnête). */
  moteur: "webgpu" | "cpu";
  /** WebGPU disponible sur ce runtime (détection réelle). */
  webgpuDisponible: boolean;
  /** Raison du repli CPU si applicable (fabrique). */
  raisonMoteur?: string;
  /** Énergie moyenne du champ du nœud. */
  energie: number;
  /** Paramètre d'ordre de Kuramoto (synchronisation globale). */
  ordreR: number;
  /** Nombre de souvenirs évalués (mémoire vivante du champ). */
  souvenirsEvalues: number;
  /** Gain de résonance cumulé des souvenirs évalués (qualité). */
  gainCumule: number;
  /** Débit de pas d'évaluation (pas/s) — la vitesse matérielle. */
  pasParSeconde: number;
  /** Rappel de doctrine encodée dans le contrat. */
  usageMateriel: "evaluation-des-ondes-uniquement";
}

const PAS_EVALUATION = 10;

/**
 * Évalue les ondes du nœud de fusion avec les ressources matérielles
 * disponibles. Le moteur d'évaluation est créé par la FABRIQUE (WebGPU
 * prioritaire, repli CPU automatique et rapporté) — le matériel TRAITE les
 * ondes : chaque souvenir est re-propagé, sa cohérence et son gain mesurés.
 */
export async function evaluerOndesMateriel(noeud: NoeudOndesUnifie): Promise<MesuresOndes> {
  const gpuDisponible = await webgpuDisponible();
  const fabrication = await creerMoteur({ ...CONFIG_FUSION, pasParImage: 1, periodeReadback: 1 });
  const moteurEvaluation: MoteurOndes = fabrication.moteur;

  const traces = noeud.dernieresTraces(24);
  const debut = performance.now();
  let pasExecutes = 0;
  let gainCumule = 0;

  for (const trace of traces) {
    // Traitement d'ondes : requête vide + souvenir réinjecté — la mesure du
    // gain de résonance EST l'évaluation matérielle (qualité du souvenir).
    moteurEvaluation.injecter(trace.impulsions);
    let energieBase = 0;
    for (let i = 0; i < PAS_EVALUATION; i++) {
      moteurEvaluation.avancer();
      pasExecutes++;
    }
    const lectureBase = await moteurEvaluation.lire();
    energieBase = lectureBase.energie;
    moteurEvaluation.injecter(trace.impulsions);
    for (let i = 0; i < PAS_EVALUATION; i++) {
      moteurEvaluation.avancer();
      pasExecutes++;
    }
    const lecture = await moteurEvaluation.lire();
    gainCumule += Math.max(0, lecture.energie - energieBase);
  }

  const dureeMs = Math.max(1, performance.now() - debut);
  const etat = await noeud.etatChamp();
  await moteurEvaluation.detruire();

  return {
    moteur: fabrication.type,
    webgpuDisponible: gpuDisponible,
    ...(fabrication.raison ? { raisonMoteur: fabrication.raison } : {}),
    energie: etat.energie,
    ordreR: etat.ordreR,
    souvenirsEvalues: traces.length,
    gainCumule,
    pasParSeconde: Math.round((pasExecutes / dureeMs) * 1000),
    usageMateriel: "evaluation-des-ondes-uniquement",
  };
}
