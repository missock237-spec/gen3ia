/**
 * SECRETS PROTECTION (UCE) — aucun secret dans les découvertes, journaux,
 * résultats d'exécution ou données d'apprentissage.
 *
 * Délègue le masquage à `lib/security/secret-masking.ts` (maskSecrets, déjà
 * utilisé par le dépôt) et ajoute : détection de motifs de jetons dans les
 * enregistrements structurés, troncature bornée des contenus stockés.
 */

import "server-only";

import { maskSecrets } from "@/lib/security/secret-masking";

/** Longueur maximale d'un champ texte persisté par l'UCE. */
export const TAILLE_CHAMP_MAX = 2_000;

/** Motifs de jetons à détecter avant persistance (fail-closed : on refuse). */
const MOTIFS_JETONS: RegExp[] = [
  /\bghp_[A-Za-z0-9]{30,}\b/, // GitHub PAT
  /\bhf_[A-Za-z0-9]{30,}\b/, // Hugging Face
  /\bKGAT_[A-Za-z0-9]{20,}\b/, // Kaggle
  /\bsk-[A-Za-z0-9]{20,}\b/, // clés type OpenAI
  /\bxox[bap]-[A-Za-z0-9-]{10,}\b/, // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM
];

export interface ResultatSanitisation {
  texte: string;
  tronque: boolean;
  /** Vrai si un motif de secret CRU a été détecté (à rejeter, pas masquer). */
  secretCrudeDetecte: boolean;
}

/** Masque + tronque un texte avant persistance/journal. */
export function sanitiserTexte(texte: string, tailleMax = TAILLE_CHAMP_MAX): ResultatSanitisation {
  const masque = maskSecrets(texte ?? "");
  const secretCrudeDetecte = MOTIFS_JETONS.some((motif) => motif.test(texte ?? ""));
  const tronque = masque.length > tailleMax;
  return {
    texte: tronque ? masque.slice(0, tailleMax) + "…[tronqué]" : masque,
    tronque,
    secretCrudeDetecte,
  };
}

/** Sanitise un objet libre (récursif, borné) pour persistance sûre. */
export function sanitiserObjet(
  valeur: unknown,
  profondeur = 0,
): { ok: boolean; valeur: unknown; secretDetecte: boolean } {
  if (profondeur > 4) return { ok: true, valeur: "[profondeur tronquée]", secretDetecte: false };
  if (typeof valeur === "string") {
    const r = sanitiserTexte(valeur);
    return { ok: !r.secretCrudeDetecte, valeur: r.texte, secretDetecte: r.secretCrudeDetecte };
  }
  if (Array.isArray(valeur)) {
    let secretDetecte = false;
    const arr = valeur.slice(0, 50).map((v) => {
      const r = sanitiserObjet(v, profondeur + 1);
      secretDetecte = secretDetecte || r.secretDetecte;
      return r.valeur;
    });
    return { ok: !secretDetecte, valeur: arr, secretDetecte };
  }
  if (valeur && typeof valeur === "object") {
    let secretDetecte = false;
    const obj: Record<string, unknown> = {};
    for (const [cle, v] of Object.entries(valeur as Record<string, unknown>).slice(0, 50)) {
      const r = sanitiserObjet(v, profondeur + 1);
      secretDetecte = secretDetecte || r.secretDetecte;
      obj[cle.slice(0, 100)] = r.valeur;
    }
    return { ok: !secretDetecte, valeur: obj, secretDetecte };
  }
  return { ok: true, valeur, secretDetecte: false };
}

/**
 * Vérifie qu'un enregistrement à persister ne contient PAS de secret cru.
 * Fail-closed : un doute = refus d'enregistrer (le secret ne traverse jamais).
 */
export function refuserSiSecret(contenu: string): { autorise: boolean; cause?: string } {
  if (MOTIFS_JETONS.some((motif) => motif.test(contenu))) {
    return { autorise: false, cause: "contenu refusé : motif de secret détecté (jamais persisté)" };
  }
  return { autorise: true };
}
