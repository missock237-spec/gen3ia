/**
 * ENCODEUR LEXICAL ONDULATOIRE — représentation CPU déterministe pour le
 * prototype Gen3 Brain.
 *
 * Contrairement au fingerprint sinusoïdal basé seulement sur le hash complet
 * du prompt, cet encodeur distribue des caractéristiques communes (mots,
 * paires de mots, trigrammes de caractères) sur un vecteur de taille bornée.
 * Deux textes partageant des termes peuvent donc avoir des vecteurs proches.
 *
 * Ce n'est PAS un embedding sémantique appris : il capture des recouvrements
 * lexicaux et morphologiques, pas le sens profond, la négation ou le contexte.
 */

import { hachagePrompt } from "../../ondes/conditionneur";

export interface OptionsEncodeurLexical {
  poidsMot?: number;
  poidsBigramme?: number;
  poidsTrigrammeCaractere?: number;
}

function normaliser(texte: string): string {
  return texte
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Index signé déterministe, sans accès réseau ni état global. */
function ajouterCaracteristique(
  vecteur: Float32Array,
  caracteristique: string,
  poids: number,
): void {
  const hash = hachagePrompt(caracteristique) >>> 0;
  const index = hash % vecteur.length;
  const signe = (hash & 0x80000000) === 0 ? 1 : -1;
  vecteur[index] += signe * poids;
}

/**
 * Produit une représentation dense de taille fixe. La normalisation L2 rend
 * les scores cosinus plus comparables lorsque les entrées n'ont pas la même
 * longueur. Coût linéaire dans la longueur du texte et le nombre de n-grammes.
 */
export function encoderTexteLexicalEnOnde(
  texte: string,
  taille: number,
  options: OptionsEncodeurLexical = {},
): Float32Array {
  if (typeof texte !== "string" || texte.trim().length === 0) {
    throw new Error("Texte lexical vide.");
  }
  if (!Number.isInteger(taille) || taille < 8 || taille > 4096) {
    throw new Error("La taille lexicale doit être un entier entre 8 et 4096.");
  }

  const poidsMot = options.poidsMot ?? 1;
  const poidsBigramme = options.poidsBigramme ?? 0.65;
  const poidsTrigramme = options.poidsTrigrammeCaractere ?? 0.18;
  for (const poids of [poidsMot, poidsBigramme, poidsTrigramme]) {
    if (!Number.isFinite(poids) || poids < 0 || poids > 10) {
      throw new Error("Les poids de l'encodeur lexical doivent être finis et compris entre 0 et 10.");
    }
  }

  const normalise = normaliser(texte);
  const mots = normalise ? normalise.split(" ") : [];
  const vecteur = new Float32Array(taille);

  if (mots.length === 0) {
    ajouterCaracteristique(vecteur, "texte-special:ponctuation", 1);
  }

  for (let i = 0; i < mots.length; i++) {
    const mot = mots[i];
    ajouterCaracteristique(vecteur, `mot:${mot}`, poidsMot);

    if (i > 0) {
      ajouterCaracteristique(vecteur, `bi:${mots[i - 1]} ${mot}`, poidsBigramme);
    }

    const padded = `^${mot}$`;
    if (padded.length >= 3) {
      for (let j = 0; j <= padded.length - 3; j++) {
        ajouterCaracteristique(vecteur, `tri:${padded.slice(j, j + 3)}`, poidsTrigramme);
      }
    }
  }

  let norme = 0;
  for (const valeur of vecteur) norme += valeur * valeur;
  norme = Math.sqrt(norme);
  if (norme > 0) {
    for (let i = 0; i < vecteur.length; i++) vecteur[i] /= norme;
  }
  return vecteur;
}
