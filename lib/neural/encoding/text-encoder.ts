/**
 * ENCODAGE DE TEXTE → ÉNERGIE NEURONALE.
 *
 * Le moteur neuronal ne consomme pas des tokens de LLM mais un vecteur
 * d'énergie sur la zone de tokens du réseau (neurones 0..37) : chaque token
 * est haché (FNV-1a 32 bits, stable et déterministe) vers un neurone de la
 * zone, et son intensité s'accumule à chaque occurrence (cap par neurone).
 *
 * Un registre inverse (neurone → tokens) est maintenu au niveau module pour
 * permettre le décodage honnête (« quels mots ont stimulé ce neurone ») et la
 * persistance de l'état appris.
 *
 * Module PUR — aucune dépendance Node, totalement déterministe.
 */

import { ZONE_TOKENS } from "../core/types";

/** Intensité injectée par occurrence d'un token (cap ci-dessous). */
export const INTENSITE_PAR_OCCURRENCE = 1.2;

/** Intensité maximale cumulée par neurone de la zone de tokens. */
export const INTENSITE_MAX_PAR_NEURONE = 3.0;

/** Nombre maximal de tokens mémorisés par neurone dans le registre inverse (FIFO). */
export const MAX_TOKENS_PAR_NEURONE = 6;

/**
 * Tokenisation : minuscules, suppression des diacritiques (NFD + retrait des
 * marques combinantes), découpage sur tout caractère non alphanumérique.
 * « Éléphant café » → ["elephant", "cafe"].
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Hachage FNV-1a 32 bits — stable, déterministe, sans dépendance (le même
 * token produit toujours le même hash, y compris entre process/restarts).
 */
export function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Résultat de l'encodage d'un texte. */
export interface EncodedText {
  /** Vecteur d'énergie { idNeurone → intensité } pour step()/inputsDirects. */
  inputs: Record<number, number>;
  /** Tokens extraits (ordre d'apparition, doublons inclus). */
  tokens: string[];
  /** Association token → neurone (ordre d'apparition). */
  neuronTokens: Array<{ token: string; neuron: number }>;
}

/** Options d'encodage. */
export interface EncodageOptions {
  /** Intensité par occurrence (défaut 1.2). */
  intensite?: number;
  /** Cap d'intensité par neurone (défaut 3.0). */
  intensiteMax?: number;
  /** Alimenter le registre inverse (défaut true). */
  majRegistre?: boolean;
}

/**
 * Registre inverse : neurone → tokens qui l'ont stimulé (max 6, FIFO).
 * État module-level partagé — pur mais mutable, exporté pour la persistance.
 */
const registreTokens = new Map<number, string[]>();

/**
 * Encode un texte en énergie neuronale : chaque token est haché vers la zone
 * 0..37 (hash % 38), l'intensité s'accumule par occurrence (1.2) et est
 * plafonnée par neurone (3.0). Le registre inverse est mis à jour.
 */
export function encodeText(
  text: string,
  opts: EncodageOptions = {},
): EncodedText {
  const intensite = opts.intensite ?? INTENSITE_PAR_OCCURRENCE;
  const intensiteMax = opts.intensiteMax ?? INTENSITE_MAX_PAR_NEURONE;
  const majRegistre = opts.majRegistre ?? true;

  const tokens = tokenize(text);
  const inputs: Record<number, number> = {};
  const neuronTokens: Array<{ token: string; neuron: number }> = [];

  for (const token of tokens) {
    const neuron = hashToken(token) % ZONE_TOKENS.taille;
    const courante = inputs[neuron] ?? 0;
    inputs[neuron] = Math.min(intensiteMax, courante + intensite);
    neuronTokens.push({ token, neuron });

    if (majRegistre) {
      enregistrerTokenDansRegistre(neuron, token);
    }
  }

  return { inputs, tokens, neuronTokens };
}

/** Ajoute un token au registre inverse du neurone (FIFO, max 6, sans doublon). */
function enregistrerTokenDansRegistre(neuron: number, token: string): void {
  let liste = registreTokens.get(neuron);
  if (!liste) {
    liste = [];
    registreTokens.set(neuron, liste);
  }
  if (liste.includes(token)) return;
  liste.push(token);
  if (liste.length > MAX_TOKENS_PAR_NEURONE) {
    liste.shift();
  }
}

/** Tokens connus d'un neurone de la zone de tokens (copie défensive). */
export function getTokensForNeuron(neuron: number): string[] {
  return [...(registreTokens.get(neuron) ?? [])];
}

/** Export complet du registre inverse (persistance du cerveau). */
export function exporterRegistreTokens(): Record<number, string[]> {
  const export_: Record<number, string[]> = {};
  for (const [neuron, tokens] of registreTokens) {
    export_[neuron] = [...tokens];
  }
  return export_;
}

/** Restaure un registre exporté (fusion : les listes remplacent les existantes). */
export function importerRegistreTokens(
  donnees: Record<number, string[]>,
): void {
  for (const [neuronTexte, tokens] of Object.entries(donnees)) {
    const neuron = Number(neuronTexte);
    if (!Number.isInteger(neuron)) continue;
    registreTokens.set(neuron, tokens.slice(0, MAX_TOKENS_PAR_NEURONE));
  }
}

/** Vide le registre inverse (reset complet du cerveau). */
export function reinitialiserRegistreTokens(): void {
  registreTokens.clear();
}
