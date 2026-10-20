/**
 * VERROU D'ENTRAÎNEMENT — un seul entraînement actif PAR MODÈLE.
 *
 * Le déploiement Gen3ia est mono-instance (PM2) : un verrou en mémoire
 * suffit et il est immédiat. Chaque verrou porte un TTL = timebox + marge :
 * même si le processus crashe sans libérer, le modèle redevient
 * entraînable au plus tard une heure et cinq minutes plus tard — la
 * garantie « 1 h par modèle par entraînement » ne peut JAMAIS être
 * contournée par un verrou fantôme.
 *
 * Le verrou sert aussi d'anti-double-clic côté UI : un second lancement
 * pour le même modèle reçoit false et la route répond 409.
 */

import { MARGE_VERROU_MS, DUREE_MAX_ENTRAINEMENT_MS } from "./timebox";

interface Verrou {
  uid: string;
  expireA: number;
}

/** TTL par défaut : timebox + marge (nettoyage, archivage final). */
export const TTL_VERROU_DEFAUT = DUREE_MAX_ENTRAINEMENT_MS + MARGE_VERROU_MS;

const verrous = new Map<string, Verrou>();

/** Clé canonique d'un entraînement : un modèle d'un projet d'un compte. */
export function cleVerrouEntrainement(uid: string, projectId: string, assetId: string): string {
  return `${uid}:${projectId}:${assetId}`;
}

/** Purge les verrous expirés (appelé à chaque accès — jamais de fuite). */
function purger(maintenant: number): void {
  for (const [cle, verrou] of verrous) {
    if (verrou.expireA <= maintenant) verrous.delete(cle);
  }
}

/** Résultat d'une tentative d'acquisition. */
export type AcquisVerrou =
  | { acquis: true; expireA: number }
  | { acquis: false; par: string; resteMs: number };

/**
 * Tente d'acquérir le verrou (atomique dans le thread unique Node).
 * `uid` est enregistré pour un diagnostic honnête en cas de conflit.
 */
export function acquerirVerrou(
  cle: string,
  uid: string,
  ttlMs: number = TTL_VERROU_DEFAUT,
  maintenant = Date.now,
): AcquisVerrou {
  purger(maintenant());
  const t = maintenant();
  const existant = verrous.get(cle);
  if (existant && existant.expireA > t) {
    return { acquis: false, par: existant.uid, resteMs: existant.expireA - t };
  }
  const expireA = t + ttlMs;
  verrous.set(cle, { uid, expireA });
  return { acquis: true, expireA };
}

/** Libère le verrou — UNIQUEMENT par son propriétaire (anti-vol). */
export function libererVerrou(cle: string, uid: string, maintenant = Date.now): void {
  const existant = verrous.get(cle);
  if (existant && existant.uid === uid) verrous.delete(cle);
  purger(maintenant());
}

/** Diagnostic : le verrou est-il actuellement tenu ? */
export function verrouTenu(cle: string, maintenant = Date.now): boolean {
  purger(maintenant());
  return verrous.has(cle);
}

/** Pour les tests : réinitialise tout l'état des verrous. */
export function reinitialiserVerrous(): void {
  verrous.clear();
}
