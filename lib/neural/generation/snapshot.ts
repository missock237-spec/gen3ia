/**
 * MOTEUR DE GÉNÉRATION LOCAUX — capture d'état neuronal.
 *
 * Les effecteurs média (visuel / audio / vidéo) du corps sémantique
 * produisent leurs sorties par des moteurs 100 % LOCAUX : aucune IA
 * externe n'est appelée. Chaque génération est une fonction DÉTERMINISTE
 * de l'état RÉEL du réseau neuronal (poids synaptiques appris pendant
 * l'entraînement, histogramme des poids, énergies) et du prompt
 * (graine de composition).
 *
 * La sortie n'est donc jamais un simulacre : le contenu produit
 * reflète structurellement l'état appris du cerveau Gen3 au moment de
 * la génération. Un cerveau entraîné différemment produit une œuvre
 * différente.
 *
 * Module PUR — aucune dépendance Node.
 */

import type { ReseauNeuronalGen3 } from "../core/network";
import { createRng } from "../core/rng";
import { encodeText, hashToken } from "../encoding/text-encoder";

/** Capture de l'état neuronal pertinent pour la génération. */
export interface NeuralSnapshot {
  /** Graine de composition = hash du prompt + seed du réseau. */
  seed: number;
  /** Nombre de neurones du réseau. */
  nbNeurones: number;
  /** Nombre de synapses du réseau. */
  nbSynapses: number;
  /** Poids synaptique moyen (appris). */
  poidsMoyen: number;
  /** Histogramme des poids en 10 classes (répartition réelle). */
  histogramme: number[];
  /** Échantillon de synapses [sourceId, cibleId, poids]. */
  echantillonSynapses: Array<[number, number, number]>;
  /** Énergies courantes d'un échantillon de neurones [id, énergie]. */
  energies: Array<[number, number]>;
  /** Tokens du prompt → neurones stimulés (zone lexicale réelle). */
  neuronTokens: Array<{ token: string; neuron: number }>;
  /** Tokens uniques du prompt (ordre d'apparition). */
  tokens: string[];
}

/** Taille de l'échantillon de synapses capturé (bornée pour la perf). */
const MAX_SYNAPSES_CAPTURE = 900;

/**
 * Capture l'état réel du réseau pour une génération. AUCUNE mutation :
 * lecture seule, aucun cycle exécuté — l'état reflète ce qui a été APPRIS.
 */
export function capturerSnapshot(
  reseau: ReseauNeuronalGen3,
  prompt: string,
): NeuralSnapshot {
  const stats = reseau.getStats();
  const encodage = encodeText(prompt, { majRegistre: false });
  const promptSeed = (hashToken(prompt.slice(0, 512)) ^ reseau.config.seed) >>> 0;

  // Échantillon régulier de synapses (répartition représentative).
  const pas = Math.max(1, Math.floor(reseau.synapses.length / MAX_SYNAPSES_CAPTURE));
  const echantillonSynapses: Array<[number, number, number]> = [];
  for (let i = 0; i < reseau.synapses.length; i += pas) {
    const s = reseau.synapses[i];
    if (s) echantillonSynapses.push([s.sourceId, s.targetId, s.weight]);
  }

  // Énergies courantes (peuvent être nulles en inférence propre — honnête).
  const energies: Array<[number, number]> = [];
  let i = 0;
  for (const [id, neurone] of reseau.neurones) {
    if (energies.length >= 120) break;
    if (i++ % Math.ceil(reseau.neurones.size / 120) === 0) {
      energies.push([id, neurone.energy]);
    }
  }

  return {
    seed: promptSeed,
    nbNeurones: stats.nbNeurones,
    nbSynapses: stats.nbSynapses,
    poidsMoyen: stats.poidsMoyen,
    histogramme: [...stats.histogramme],
    echantillonSynapses,
    energies,
    neuronTokens: encodage.neuronTokens,
    tokens: [...new Set(encodage.tokens)],
  };
}

/** Crée un RNG seedé depuis le snapshot (déterminisme complet). */
export function rngDepuisSnapshot(snapshot: NeuralSnapshot, salt = 0): () => number {
  return createRng((snapshot.seed + salt) >>> 0);
}

/** Choisit un item d'une liste de façon déterministe via le RNG fourni. */
export function choisir<T>(rng: () => number, liste: readonly T[]): T {
  return liste[Math.floor(rng() * liste.length) % liste.length]!;
}

/** Palette AURORA de base du projet (identité Gen3ia). */
export const PALETTE_AURORA = [
  "#7C5CFF", // primaire Gen3ia
  "#9D8CFF",
  "#5EEAD4",
  "#38BDF8",
  "#F472B6",
  "#FBBF24",
  "#A78BFA",
  "#34D399",
] as const;

/** Teinte (hue 0-360) dérivée du hash du prompt — identité chromatique du prompt. */
export function teinteDuPrompt(prompt: string): number {
  return hashToken(prompt.slice(0, 256) || "gen3") % 360;
}

/** Hash 32 bits simple d'une chaîne (signé — usage modulo interne). */
export function hashTexte32(texte: string): number {
  return hashToken(texte) | 0;
}

/** Convertit HSL → hex (composition SVG). */
export function hslVersHex(h: number, s: number, l: number): string {
  const hNorm = ((h % 360) + 360) % 360;
  const sN = Math.min(1, Math.max(0, s));
  const lN = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((hNorm / 60) % 2) - 1));
  const m = lN - c / 2;
  const [r, g, b] =
    hNorm < 60 ? [c, x, 0] :
    hNorm < 120 ? [x, c, 0] :
    hNorm < 180 ? [0, c, x] :
    hNorm < 240 ? [0, x, c] :
    hNorm < 300 ? [x, 0, c] :
    [c, 0, x];
  const hex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Échappe le texte pour insertion sûre en XML/SVG. */
export function echapperXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Tronque proprement un libellé (ellipse). */
export function tronquer(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
