import "server-only";

/**
 * JOURNAL CHAÎNÉ — le journal d'audit est INVIOLEMENT falsifiable :
 * chaque entrée scelle la précédente (HMAC-SHA256 en chaîne, façon
 * blockchain miniature). Supprimer une entrée, en modifier une, ou en
 * réordonner deux casse TOUTE la chaîne au-delà du point d'attaque :
 * `verifierChaine` le détecte. Un attaquant — y compris automatisé —
 * ne peut pas réécrire l'historique sans re-forger la clé, qui vit
 * hors du stockage utilisateur.
 *
 * Contrat : `chaîner(entrées)` recalcule les empreintes à partir d'un
 * point d'ancrage (dernière empreinte connue du mois précédent) ;
 * `verifierChaine(entrées)` rejoue le calcul et compare. L'ordre du
 * tableau = l'ordre chronologique DÉFINI par l'appelant (at croissant).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const FORMAT_JOURNAL = "gen3ia-journal-v1";

/** Clé de chaînage — même matière maîtresse que la forteresse. */
function cleChaine(): Buffer {
  const explicite = process.env.MODELS_SEALING_KEY?.trim();
  if (explicite) return createHash("sha256").update(`gen3ia-journal|${explicite}`).digest();
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (sessionSecret) return createHash("sha256").update(`gen3ia-journal|${sessionSecret}`).digest();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL ?? "";
  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
    "demo-gen3ia";
  return createHash("sha256").update(`gen3ia-journal|${projectId}|${clientEmail}|${privateKey}`).digest();
}

/** Empreinte canonique d'une entrée (stable : clés triées). */
export function empreinteEntree(entree: Record<string, unknown>, hashPrecedent: string): string {
  const canonique = JSON.stringify(entree, Object.keys(entree).sort());
  return createHmac("sha256", cleChaine()).update(`${hashPrecedent}|${canonique}`).digest("hex");
}

export interface EntreeChaînée<T extends Record<string, unknown>> {
  entree: T;
  hash: string;
  hashPrev: string;
}

/**
 * Chaîne une liste d'entrées (ordre chronologique) à partir d'un
 * ancrage (dernier hash connu, "genesis" par défaut).
 */
export function chainer<T extends Record<string, unknown>>(
  entrees: T[],
  ancrage = "genesis",
): Array<EntreeChaînée<T>> {
  const resultat: Array<EntreeChaînée<T>> = [];
  let precedent = ancrage;
  for (const entree of entrees) {
    const hash = empreinteEntree(entree as Record<string, unknown>, precedent);
    resultat.push({ entree, hash, hashPrev: precedent });
    precedent = hash;
  }
  return resultat;
}

export type VerdictChaine =
  | { valide: true; jusquA: string | null }
  | { valide: false; raison: "ordre" | "falsifie"; a: number; jusquA: string | null };

/**
 * Vérifie une chaîne d'entrées (format chainer). Retourne la position
 * de la première rupture pour un diagnostic honnête.
 */
export function verifierChaine<T extends Record<string, unknown>>(
  entreesChaînées: Array<EntreeChaînée<T>>,
  ancrage = "genesis",
): VerdictChaine {
  let precedent = ancrage;
  for (let i = 0; i < entreesChaînées.length; i++) {
    const { entree, hash, hashPrev } = entreesChaînées[i];
    if (hashPrev !== precedent) return { valide: false, raison: "ordre", a: i, jusquA: precedent };
    const attendu = empreinteEntree(entree as Record<string, unknown>, precedent);
    const recu = Buffer.from(hash, "hex");
    const attenduBuf = Buffer.from(attendu, "hex");
    if (recu.length !== attenduBuf.length || !timingSafeEqual(recu, attenduBuf)) {
      return { valide: false, raison: "falsifie", a: i, jusquA: precedent };
    }
    precedent = hash;
  }
  return { valide: true, jusquA: precedent === "genesis" ? null : precedent };
}

/** Ancre « genesis » explicite (première entrée d'un journal). */
export const GENESIS = "genesis";

/** Empreinte d'ancrage indépendante (pour relier deux mois entre eux). */
export function ancreJournal(uid: string, mois: string): string {
  return createHmac("sha256", cleChaine()).update(`ancre|${uid}|${mois}`).digest("hex").slice(0, 32);
}
