import "server-only";

import {
  beginFirestoreProbe,
  isFirestoreQuotaError,
  noteFirestoreQuotaError,
  noteFirestoreStall,
  noteFirestoreSuccess,
  shouldShortCircuitFirestore,
} from "@/lib/db/quota-guard";

/**
 * Garde Firestore de la file de missions et des checkpoints — Task 110-d.
 *
 * CAUSE RACINE 110-d (« plus aucune tâche ne s'exécute » dans la
 * conversation, chat texte OK) : après la bascule R2 des données
 * utilisateur (Tasks 108/109), le chemin TÂCHE est resté le SEUL chemin
 * branché en direct sur Firestore brute (`adminDb`) sans AUCUN des deux
 * gardes pourtant éprouvés en production :
 *  - la DEADLINE anti-stall (Task 97 : sous quota quotidien épuisé, les
 *    ÉCRITURES Firestore ne remontent PAS l'erreur RESOURCE_EXHAUSTED,
 *    elles PENDENT indéfiniment côté SDK — constaté en production le 05/10) ;
 *  - le DISJONCTEUR quota (Task 95-b : court-circuiter les appels tant que
 *    le quota ne revient pas).
 *
 * Résultat sous quota Firestore : `createQueuedMission` pend jusqu'au
 * timeout de la fonction (maxDuration 300), `claimMissionTick` /
 * `loadCheckpoint` / `getWallet` meurent ou pendent dans les ticks → la
 * mission n'est jamais enfilée, jamais exécutée, jamais finalisée — pendant
 * que le chat (100 % R2) répond normalement.
 *
 * Ce module applique aux touches Firestore restantes du chemin tâche la
 * doctrine EXACTE de lib/db/firestore-resilient (deadline 6 s + classification
 * quota + disjoncteur process-local), SANS changer la sémantique métier des
 * appelants :
 *  - disjoncteur ouvert → rejet IMMÉDIAT quota-classifié (l'appelant applique
 *    sa politique : repli synchrone, 500 redélivrance QStash, fail-soft…) ;
 *  - aucune réponse dans FIRESTORE_GUARD_TIMEOUT_MS → STALL noté
 *    (noteFirestoreStall ouvre le disjoncteur) + rejet quota-classifié ;
 *  - succès → disjoncteur refermé ; erreur quota réelle → notée puis
 *    rejetée ; erreurs transitoires/métier → rejetées SANS toucher au
 *    disjoncteur (contrat isFirestoreTransientError).
 *
 * Contrat de classification : les erreurs du garde portent « Firestore »
 * (errorStatus → 503) et « quota » (isFirestoreQuotaError → true) — les
 * chemins de reprise existants (repli synchrone du chat, 503 actionnable)
 * s'engagent sans modification.
 */

/** Délai imparti à CHAQUE tentative Firestore (même valeur que FIRESTORE_ATTEMPT_TIMEOUT_MS de la couche résiliente). */
export const FIRESTORE_GUARD_TIMEOUT_MS = 6_000;

/**
 * Erreur synthétique « disjoncteur ouvert » : message portant « Firestore »
 * et « quota » pour rester quota-classifié par isFirestoreQuotaError ET
 * mappé 503 par errorStatus (DEGRADED_MESSAGE_RE).
 */
export function firestoreBreakerError(): Error {
  return new Error("Firestore sous quota : disjoncteur ouvert, appel court-circuité (reprise après cooldown).");
}

/**
 * Le garde autorise-t-il une tentative Firestore ? Disjoncteur fermé : oui.
 * Mi-ouvert : l'unique sonde est consommée ICI (beginFirestoreProbe) pour
 * tenter de refermer le circuit sur un appel réel — même expression que
 * firestoreUsable() de la couche résiliente.
 */
function guardUsable(): boolean {
  return !shouldShortCircuitFirestore() || beginFirestoreProbe();
}

/**
 * Exécute `op` (un appel Firestore brut) sous double garde :
 *  1. disjoncteur : ouvert → rejet immédiat (quota-classifié) ;
 *  2. deadline : sans réponse en FIRESTORE_GUARD_TIMEOUT_MS → stall noté
 *     (disjoncteur ouvert immédiatement) + rejet quota-classifié.
 *
 * Le rejet tardif de `op` (après timeout) est absorbé par la course
 * (Promise.race souscrit aux deux promesses — jamais d'unhandledRejection).
 */
export async function runFirestoreGuarded<T>(label: string, op: () => Promise<T>): Promise<T> {
  if (!guardUsable()) throw firestoreBreakerError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const detail = `${label}: aucune réponse en ${FIRESTORE_GUARD_TIMEOUT_MS}ms`;
          noteFirestoreStall(detail);
          reject(new Error(`${detail} (probablement quota Firestore épuisé).`));
        }, FIRESTORE_GUARD_TIMEOUT_MS);
      }),
    ]);
    // L'appel a répondu (même « doc absent ») : le circuit se referme.
    noteFirestoreSuccess();
    return result;
  } catch (error) {
    // Une erreur quota réelle est notée au disjoncteur puis rejetée telle
    // quelle (la politique de reprise reste à l'appelant) ; les erreurs
    // transitoires/métier passent SANS toucher au disjoncteur.
    if (isFirestoreQuotaError(error)) noteFirestoreQuotaError(error);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
