/**
 * ATTENTION SPIKE-DRIVEN (méthode d'amélioration 1 de l'analyse experte).
 *
 * Mécanisme d'attention PONDÉRÉ PAR LES SPIKES au-dessus du champ d'ondes :
 *  · chaque souvenir (paquet d'ondes commis) est RÉINJECTÉ dans le MÊME
 *    champ que la requête — la lecture mémoire EST un calcul neuronal ;
 *  · le poids d'attention d'un souvenir dépend de la LATENCE du pic de
 *    résonance qu'il déclenche (dynamique spiking : un souvenir qui
 *    résonne vite et fort pèse davantage — latence ∈ [1, N] pas) et de
 *    l'ALIGNEMENT DE PHASE de Kuramoto (cohérence locale) ;
 *  · softmax à température bornée → répartitions comparables.
 *
 * C'est l'analogue « spike-driven » des couches d'attention des
 * Transformers : les dépendances à long terme du langage sont portées par
 * la physique du champ (latence + cohérence) au lieu d'un produit
 * matriciel dense — le calcul est économe (physique locale, pas GEMM).
 */

import type { Impulsion } from "@/lib/ondes/types";

/** Une trace mnémonique commise dans le champ (mémoire = réseau). */
export interface TraceMnemonique {
  id: string;
  impulsions: Impulsion[];
  /** Texte source (la forme — les ondes sont le sens). */
  texte: string;
  modalite: "texte" | "image" | "audio";
  horodatage: number;
  /** Concept canonique dominant (extraction lexique simple). */
  concepts: string[];
}

export interface PoidsAttention {
  traceId: string;
  /** Poids d'attention normalisé (softmax, somme = 1). */
  poids: number;
  /** Gain de résonance brut mesuré dans le champ (≥ 0). */
  gainResonance: number;
  /** Latence du pic (nombre de pas avant le maximum de cohérence). */
  latencePic: number;
}

export interface ResultatAttention {
  poids: PoidsAttention[];
  /** La trace la plus « résonante » après attention (peut être null). */
  dominante: PoidsAttention | null;
  /** Énergie de base de la requête seule (référence de mesure). */
  energieRequete: number;
}

const TEMPERATURE = 0.35; // température softmax — bornée, déterministe
const LATENCE_TAU = 6; // constante de temps du décroissement (pas)

/** Mesure la latence du pic : premier pas où le gain culmine. */
function mesurerLatencePic(gainsParPas: number[]): number {
  if (gainsParPas.length === 0) return Number.POSITIVE_INFINITY;
  let meilleurIndice = 0;
  let meilleureValeur = -Infinity;
  for (let i = 0; i < gainsParPas.length; i++) {
    if (gainsParPas[i] > meilleureValeur) {
      meilleureValeur = gainsParPas[i];
      meilleurIndice = i;
    }
  }
  return meilleurIndice + 1; // latence en pas (1-based)
}

/** Softmax à température — déterministe, stabilité numérique. */
export function softmaxTemperature(valeurs: number[], temperature = TEMPERATURE): number[] {
  if (valeurs.length === 0) return [];
  const max = Math.max(...valeurs);
  const exps = valeurs.map((v) => Math.exp((v - max) / temperature));
  const somme = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / somme);
}

/**
 * Attention spike-driven : pour chaque trace candidate, `mesurerTrace`
 * retourne {gainsParPas, alignementPhase} MESURÉS dans le champ réel ;
 * le poids final = softmax(gain × alignement × décroissance latence).
 */
export function attentionSpikeDriven(
  traces: TraceMnemonique[],
  mesurerTrace: (trace: TraceMnemonique) => { gainsParPas: number[]; alignementPhase: number },
  energieRequete: number,
): ResultatAttention {
  if (traces.length === 0 || energieRequete <= 0) {
    return { poids: [], dominante: null, energieRequete };
  }
  const mesures = traces.map((trace) => {
    const { gainsParPas, alignementPhase } = mesurerTrace(trace);
    const gainBrut = gainsParPas.reduce((a, b) => a + b, 0);
    const latence = mesurerLatencePic(gainsParPas);
    // Décroissance spiking : une trace qui résonne LATE pèse moins
    // (exp(-latence/τ)) — la réactivité du pic est porteuse de pertinence.
    const decroissance = Number.isFinite(latence) ? Math.exp(-latence / LATENCE_TAU) : 0;
    const score = Math.max(0, gainBrut) * alignementPhase * decroissance;
    return { traceId: trace.id, score, gainResonance: gainBrut, latencePic: latence };
  });
  const poidsBruts = softmaxTemperature(mesures.map((m) => m.score));
  const poids: PoidsAttention[] = mesures.map((m, i) => ({
    traceId: m.traceId,
    poids: poidsBruts[i],
    gainResonance: m.gainResonance,
    latencePic: m.latencePic,
  }));
  const dominante = poids.reduce<PoidsAttention | null>((meilleur, p) => (meilleur === null || p.poids > meilleur.poids ? p : meilleur), null);
  return { poids, dominante, energieRequete };
}
