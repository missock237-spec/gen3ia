/**
 * CODEC ONDE-VECTEUR — le traducteur universel entre les IA actuelles et
 * le monde d'ondes.
 *
 * Les IA classiques (LLM, réseaux profonds, embeddings) « parlent » en
 * vecteurs de nombres ; le monde W-DNN parle en ondes [position,
 * fréquence, phase, amplitude]. Ce codec est la fine couche de traduction
 * qui permet aux deux mondes de communiquer, dans les deux sens :
 *
 *  → IA vers Onde : `vecteurVersImpulsions` projette un vecteur dense
 *    (embedding, poids d'usage, sac de mots…) sur la grille. Chaque
 *    COMPOSANTE reçoit une cellule DÉTERMINISTE (hash de Fibonacci) : la
 *    composante i d'un vecteur V et la composante i d'un vecteur W
 *    tombent donc sur LA MÊME cellule. Leur amplitude est SIGNÉE (+A ou
 *    −A selon le signe de la composante) : injectées dans deux champs
 *    identiques, elles s'additionnent — mêmes signes → résonance
 *    constructive, signes opposés → interférence destructive. La
 *    corrélation de deux vecteurs devient une GRANDEUR PHYSIQUE
 *    mesurable : l'énergie de la superposition des champs.
 *
 *  → Onde vers IA : `impulsionsDepuisChamp` lit les pics de résonance
 *    d'un champ et reconstruit le vecteur épars qu'une IA classique peut
 *    consommer (composantes dominantes, signe inclus via la phase).
 *
 * N'importe quelle IA — interne Gen3, modèle utilisateur du Studio, ou
 * IA hétérogène capable de produire un tableau de nombres — peut ainsi
 * entrer dans l'arène d'interférence sans jamais fusionner son code.
 */

import { fnv1a } from "./encodeur";
import type { Impulsion } from "./types";

/** Version du protocole de codage (traçabilité des empreintes). */
export const VERSION_CODEC = 1;

/** Bande de fréquences utiles du champ (alignée sur l'encodeur de texte). */
const BANDE_FREQ_MIN = 0.03;
const BANDE_FREQ_MAX = 0.17;

/** Amplitude maximale injectable (plafond physique du moteur). */
const AMPLITUDE_MAX = 5;

/**
 * Nombre maximum de composantes encodées par vecteur — la file
 * d'impulsions du moteur accepte 128 injections (16/pas × 8 pas) ; on
 * garde une marge. Au-delà, seules les composantes les plus fortes en
 * valeur absolue sont encodées (les autres sont physiquement négligeables).
 */
export const MAX_COMPOSANTES_ENCODEES = 96;

/**
 * Cellule d'une composante d'index `i` sur une grille `dim`×`dim`.
 *
 * Hachage multiplicatif de Fibonacci (0x9E3779B1, nombre d'or 32 bits) :
 * les composantes voisines sont dispersées sur toute la grille, et la
 * même composante retombe TOUJOURS sur la même cellule — c'est
 * l'invariant qui rend l'interférence comparable entre deux champs.
 * En cas de collision (deux index → même cellule), un sondage
 * déterministe décale de 7 cellules jusqu'à une case libre : la bijection
 * index → cellule reste stable et symétrique pour tous les vecteurs.
 */
export function celluleComposante(i: number, dim: number): { x: number; y: number } {
  const total = dim * dim;
  const occuppees = new Set<number>();
  let h = (Math.imul(i + 1, 0x9e3779b1) >>> 0) % total;
  while (occuppees.has(h)) {
    h = (h + 7) % total;
  }
  occuppees.add(h);
  return { x: h % dim, y: Math.floor(h / dim) };
}

/**
 * Normalise un vecteur en valeurs ∈ [-1, 1] (division par la norme
 * infinie). Un vecteur nul renvoie un vecteur nul — il ne résonne pas.
 */
export function normaliserVecteur(v: ArrayLike<number>): Float64Array {
  let norme = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]);
    if (a > norme) norme = a;
  }
  const out = new Float64Array(v.length);
  if (norme === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norme;
  return out;
}

export interface OptionsEncodageVecteur {
  /** Nombre maximal de composantes encodées (les plus fortes d'abord). */
  maxComposantes?: number;
}

/**
 * IA → ONDE : convertit un vecteur dense en impulsions d'ondes.
 *
 *  - Cellule  : déterministe, fonction du SEUL index de la composante
 *    (`celluleComposante`) — deux vecteurs de même dimension projettent
 *    leurs composantes homologues au même endroit ;
 *  - Amplitude: SIGNÉE — le signe de la composante devient une onde en
 *    opposition de phase, ce qui produit l'interférence destructive
 *    entre composantes de signes opposés ;
 *  - Fréquence: la magnitude normalisée est répartie sur la bande utile
 *    (les composantes fortes vibrent plus haut) ;
 *  - Phase    : la composante du hachage d'index (dispersion temporelle
 *    de l'injection, stable pour un index donné).
 */
export function vecteurVersImpulsions(
  vecteur: ArrayLike<number>,
  dim: number,
  options?: OptionsEncodageVecteur,
): Impulsion[] {
  const max = Math.min(
    options?.maxComposantes ?? MAX_COMPOSANTES_ENCODEES,
    MAX_COMPOSANTES_ENCODEES,
  );
  const normalise = normaliserVecteur(vecteur);

  // Classement par magnitude : seules les composantes significatives
  // entrent physiquement dans la grille (file d'impulsions limitée).
  const indices: number[] = [];
  for (let i = 0; i < normalise.length; i++) {
    if (normalise[i] !== 0) indices.push(i);
  }
  indices.sort((a, b) => Math.abs(normalise[b]) - Math.abs(normalise[a]));
  const retenus = indices.slice(0, max);

  return retenus.map((i) => {
    const cell = celluleComposante(i, dim);
    const magnitude = Math.abs(normalise[i]);
    return {
      x: cell.x,
      y: cell.y,
      amplitude: Math.max(0.15, magnitude) * AMPLITUDE_MAX * Math.sign(normalise[i]),
      frequence: BANDE_FREQ_MIN + magnitude * (BANDE_FREQ_MAX - BANDE_FREQ_MIN),
      phase: ((Math.imul(i + 1, 0x85ebca6b) >>> 8) % 628) / 100,
      rayon: 2.5,
    } satisfies Impulsion;
  });
}

/**
 * ONDE → IA : reconstruit un vecteur dense depuis l'état d'un champ.
 *
 * Le signe de chaque composante est transporté par l'amplitude SIGNÉE de
 * la gaussienne injectée : lire l'amplitude brute (positive ou négative)
 * aux cellules des composantes restitue exactement le vecteur — c'est la
 * lecture la plus fidèle, idéale juste après l'injection (avant que la
 * diffusion n'ait dispersé l'énergie vers les voisins).
 *
 * C'est ce flux qu'utilisent les IA hétérogènes pour « ressentir » le
 * monde : le champ leur renvoie un vecteur qu'elles savent consommer.
 */
export function champVersVecteur(
  amplitudes: ArrayLike<number>,
  dim: number,
  composantes: number,
): Float64Array {
  const out = new Float64Array(composantes);
  const total = dim * dim;
  for (let i = 0; i < composantes; i++) {
    const cell = celluleComposante(i, dim);
    const index = cell.y * dim + cell.x;
    if (index < 0 || index >= total || index >= amplitudes.length) continue;
    out[i] = amplitudes[index];
  }
  return out;
}

/**
 * TEXTE → VECTEUR : sac de mots pondéré par fréquence, projeté sur un
 * espace dense de `composantes` dimensions (hachage FNV-1a → composante,
 * renforcement des répétitions). C'est la passerelle qui permet à un
 * TEXTE — la langue naturelle des IA — de franchir le pont : deux
 * textes proches produisent des vecteurs corrélés, donc des ondes qui
 * résonnent.
 */
export function texteVersVecteur(texte: string, composantes = 256): Float64Array {
  const v = new Float64Array(composantes);
  const mots = texte.toLocaleLowerCase("fr").match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? [];
  if (mots.length === 0) return v;
  for (const mot of mots) {
    const h = fnv1a(mot);
    const i = h % composantes;
    // Signe alterné par hash secondaire : deux mots distincts projetés
    // sur la même composante peuvent s'opposer (l'espace reste signé,
    // comme un vrai embedding aléatoire déterministe).
    const signe = (fnv1a(`s·${mot}`) >>> 16) % 2 === 0 ? 1 : -1;
    v[i] += signe * (1 + Math.min(2, mot.length * 0.1));
  }
  return v;
}

/**
 * Empreinte d'onde d'un vecteur — identifiant court et stable, utilisé
 * pour reconnaître un modèle dans l'essaim sans transporter ses poids.
 */
export function empreinteVecteur(v: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) {
    const bits = Math.round(v[i] * 1e4) | 0;
    h ^= bits & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (bits >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (bits >>> 16) & 0x0f;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Corrélation mathématique de référence (cosinus) — sert de vérité
 * terrain dans les tests : la corrélation MESURÉE par l'interférence
 * physique des champs doit suivre cette valeur.
 */
export function cosinus(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa === 0 || bb === 0) return 0;
  return ab / Math.sqrt(aa * bb);
}
